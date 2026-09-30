import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiConfig } from './ai.config.js';
import { AiGatewayService } from './ai-gateway.service.js';

/* IA-8 — surveillance des conversations (SIGNAL uniquement, jamais une
 * sanction : l'IA ne parle jamais dans le chat, ne modifie/supprime rien,
 * ne bloque rien — tout reste best-effort après enregistrement du message,
 * toute décision reste humaine via la revue admin).
 *
 * - Déclenché après `message.create` (fire-and-forget, jamais bloquant) ;
 * - fenêtre de contexte bornée (pas de payload gigantesque) ;
 * - minimisation stricte : rôles + contenus tronqués + contexte métier
 *   minimal (jamais téléphone/email/adresse/GPS/KYC/soldes/secrets) ;
 * - idempotent par message (messageId unique, rejoué sans doublon) ;
 * - seuil de confiance centralisé `AiConfig` (jamais dispersé) ;
 * - historique immuable (revue/dismiss conservés, rien supprimé) ;
 * - logs techniques uniquement (ids + catégorie/confiance/sévérité/
 *   modèle/durée — jamais de contenu de conversation).
 *
 * RGPD/rétention : reportés à IA-10 (aucune politique improvisée ici). */

export const AI_CONVERSATION_PROMPT_VERSION = 1;
/** Messages récents analysés avec le courant (fenêtre bornée, §5/§34). */
export const AI_CONVERSATION_CONTEXT_MESSAGES = 10;
/** Troncature par message envoyé au modèle (payload borné). */
export const AI_CONVERSATION_MAX_MESSAGE_CHARS = 1000;
/** Contexte métier : diagnostic et devis résumés (contenus tronqués). */
export const AI_CONVERSATION_MAX_CONTEXT_CHARS = 500;
/** Raison du modèle : synthèse factuelle courte, bornée avant persistance. */
export const AI_CONVERSATION_MAX_REASON_CHARS = 500;
export const AI_CONVERSATION_MAX_TOKENS = 500;

export const AI_CONVERSATION_CATEGORIES = [
  'OFF_PLATFORM_PAYMENT',
  'OFF_PLATFORM_CONTACT',
  'CONVERSATION_INCONSISTENCY',
  'PRICE_DISCREPANCY',
  'POTENTIAL_FRAUD',
  'ABUSIVE_OR_PRESSURING_BEHAVIOR',
  'OTHER',
] as const;

export type AiConversationCategory = (typeof AI_CONVERSATION_CATEGORIES)[number];

export const AI_CONVERSATION_SEVERITIES = ['LOW', 'MEDIUM', 'HIGH'] as const;

export type AiConversationSeverity = (typeof AI_CONVERSATION_SEVERITIES)[number];

export type AiConversationFlagStatus = 'OPEN' | 'REVIEWED' | 'DISMISSED';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function truncate(text: string, maxLength: number): string {
  const trimmed = text.trim();
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

@Injectable()
export class AiConversationWatchService {
  private readonly logger = new Logger(AiConversationWatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly aiConfig: AiConfig,
    private readonly gateway: AiGatewayService,
  ) {}

  get minConfidence(): number {
    return this.aiConfig.chatMinConfidence;
  }

  get timeoutMs(): number {
    return this.aiConfig.chatTimeoutMs;
  }

  /** Analyse un message enregistré (idempotent, jamais d'exception vers
   *  l'appelant : le chat fonctionne même IA indisponible). */
  async analyzeMessage(messageId: string): Promise<unknown> {
    try {
      return await this.analyzeMessageOrThrow(messageId);
    } catch (error) {
      this.logger.warn(
        `Surveillance conversationnelle impossible pour ${messageId} : ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }.`,
      );
      return null;
    }
  }

  private async analyzeMessageOrThrow(messageId: string): Promise<unknown> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, demandeId: true, senderId: true, content: true, createdAt: true },
    });
    if (!message) return null;
    const sender = await this.prisma.user.findUnique({
      where: { id: message.senderId },
      select: { id: true, role: true },
    });
    if (!sender || (sender.role !== 'CLIENT' && sender.role !== 'TECHNICIAN')) return null;

    // Idempotence : un message → au plus un flag (rejoué sans doublon).
    const existing = await this.prisma.aiConversationFlag.findUnique({
      where: { messageId: message.id },
    });
    if (existing) return existing;

    if (!this.aiConfig.isConfigured()) {
      this.logger.log(
        `Surveillance conversationnelle inactive pour ${message.id} (${this.aiConfig.refusalReason() ?? 'non configurée'}).`,
      );
      return null;
    }

    const userPrompt = await this.buildUserPrompt(message);
    let parsed: Record<string, unknown>;
    let model: string;
    try {
      const completion = await this.gateway.completeJson<unknown>({
        caller: 'AiConversationWatch',
        messages: [
          { role: 'system', content: this.systemPrompt() },
          { role: 'user', content: userPrompt },
        ],
        timeoutMs: this.timeoutMs,
        correlationId: message.id,
      });
      model = completion.model;
      const record = asRecord(completion.result);
      if (!record) {
        this.logger.warn(`Signal conversationnel inexploitable pour ${message.id} (JSON invalide).`);
        return null;
      }
      parsed = record;
    } catch (error) {
      // Timeout / 429 / 5xx / désactivé : message conservé, aucun flag,
      // erreur tracée (ids uniquement, jamais le contenu).
      this.logger.warn(
        `Analyse conversationnelle impossible pour ${message.id} : ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }.`,
      );
      return null;
    }

    const validated = this.validateSignal(parsed);
    if (!validated) return null;
    if (validated.flagged === false) return null;
    if (validated.confidence < this.minConfidence) {
      this.logger.log(
        `Signal conversationnel écarté pour ${message.id} (confiance insuffisante).`,
      );
      return null;
    }

    try {
      const flag = await this.prisma.aiConversationFlag.create({
        data: {
          demandeId: message.demandeId,
          messageId: message.id,
          senderId: message.senderId,
          senderRole: sender.role,
          category: validated.category,
          confidence: validated.confidence,
          severity: validated.severity,
          reason: validated.reason,
          model,
          promptVersion: AI_CONVERSATION_PROMPT_VERSION,
          status: 'OPEN',
        },
      });
      // Log technique uniquement : ids + catégorie/confiance/sévérité/
      // modèle — jamais de contenu de conversation ni de PII.
      this.logger.log(
        `Signal conversationnel ${flag.id} (message ${message.id}, ${validated.category}, ` +
          `confiance ${validated.confidence}, ${validated.severity}, modèle ${model}).`,
      );
      await this.notifyAdminsIfSevere(flag);
      return flag;
    } catch (error) {
      // Doublon concurrent (P2002) : relire l'existant, sinon tracer.
      const code = (error as { code?: string }).code;
      if (code === 'P2002') {
        return this.prisma.aiConversationFlag.findUnique({ where: { messageId: message.id } });
      }
      this.logger.warn(
        `Signal conversationnel impossible pour ${message.id} : ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }.`,
      );
      return null;
    }
  }

  /* Contexte minimal et borné : message courant + fenêtre récente (rôles
   * uniquement, contenus tronqués) + demande/diagnostic/devis résumés.
   * EXCLUS : téléphone, email, adresse, GPS, KYC, soldes, payouts, tokens,
   * secrets — ces colonnes ne sont jamais sélectionnées. */
  private async buildUserPrompt(message: {
    id: string;
    demandeId: string;
    senderId: string;
    content: string;
  }): Promise<string> {
    const [recent, demande, diagnostic, quotes] = await Promise.all([
      this.prisma.message.findMany({
        where: { demandeId: message.demandeId },
        orderBy: { createdAt: 'desc' },
        take: AI_CONVERSATION_CONTEXT_MESSAGES + 1,
        select: { id: true, senderId: true, content: true, createdAt: true },
      }),
      this.prisma.demande.findUnique({
        where: { id: message.demandeId },
        select: { id: true, reference: true, category: true, status: true },
      }),
      this.prisma.diagnostic.findFirst({
        where: { demandeId: message.demandeId },
        orderBy: { createdAt: 'desc' },
        select: { content: true, proposedIntervention: true },
      }),
      this.prisma.quote.findMany({
        where: { demandeId: message.demandeId },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { amount: true, currency: true, status: true, source: true },
      }),
    ]);
    const ordered = [...recent].reverse();
    const lines = ordered.map((row) =>
      row.id === message.id
        ? `[MESSAGE À ANALYSER — ${row.senderId === message.senderId ? 'auteur courant' : 'autre'}] ${truncate(row.content, AI_CONVERSATION_MAX_MESSAGE_CHARS)}`
        : `[${row.senderId === message.senderId ? 'même auteur' : 'interlocuteur'}] ${truncate(row.content, AI_CONVERSATION_MAX_MESSAGE_CHARS)}`,
    );
    const context: string[] = [];
    if (demande) {
      context.push(`Mission ${demande.reference} : ${demande.category} (statut ${demande.status}).`);
    }
    if (diagnostic) {
      const intervention = diagnostic.proposedIntervention
        ? ` Intervention proposée : ${truncate(diagnostic.proposedIntervention, AI_CONVERSATION_MAX_CONTEXT_CHARS)}.`
        : '';
      context.push(
        `Dernier diagnostic : ${truncate(diagnostic.content, AI_CONVERSATION_MAX_CONTEXT_CHARS)}.${intervention}`,
      );
    }
    for (const quote of quotes) {
      context.push(
        `Devis ${quote.source} ${quote.status} : ${quote.amount} ${quote.currency}.`,
      );
    }
    return [...context, '---', ...lines].join('\n');
  }

  private systemPrompt(): string {
    return [
      'Tu surveilles une conversation du service de dépannage Relio.',
      'Tu produis UNIQUEMENT un signal de surveillance, jamais une conclusion de culpabilité.',
      'Réponds UNIQUEMENT en JSON strict, sans texte autour, avec ce schéma exact :',
      '{"flagged": true, "category": "OFF_PLATFORM_PAYMENT", "confidence": 0.0, "severity": "HIGH", "reason": "phrase factuelle courte"}',
      `Catégories : ${AI_CONVERSATION_CATEGORIES.join(', ')}.`,
      '"confidence" est entre 0 et 1. "severity" vaut LOW, MEDIUM ou HIGH (priorité de revue, pas une preuve).',
      'Règles : une simple mention de numéro, de mot ou de moyen de contact ne suffit jamais — exige un contexte de contournement, de contradiction ou de pression.',
      'Pas de diagnostic psychologique, pas de spéculation : descriptions comportementales factuelles.',
      '"flagged" vaut false (avec category OTHER, confidence 0, severity LOW) si rien de pertinent.',
      '"reason" est une phrase courte, factuelle, sans accuser personne.',
    ].join('\n');
  }

  /* Valide la sortie modèle (enums, confiance 0..1, raison bornée).
   * Invalide → null (message conservé, aucun flag, §30). */
  private validateSignal(parsed: Record<string, unknown>): {
    flagged: boolean;
    category: AiConversationCategory;
    confidence: number;
    severity: AiConversationSeverity;
    reason: string | null;
  } | null {
    if (parsed.flagged !== true) {
      // false / absent / non-booléen : aucun signal (comportement sûr).
      if (parsed.flagged === false) return { flagged: false } as never;
      return null;
    }
    if (!AI_CONVERSATION_CATEGORIES.includes(parsed.category as AiConversationCategory)) return null;
    const confidence =
      typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.min(Math.max(parsed.confidence, 0), 1)
        : null;
    if (confidence === null) return null;
    if (!AI_CONVERSATION_SEVERITIES.includes(parsed.severity as AiConversationSeverity)) return null;
    const reason =
      typeof parsed.reason === 'string' && parsed.reason.trim()
        ? truncate(parsed.reason, AI_CONVERSATION_MAX_REASON_CHARS)
        : null;
    return {
      flagged: true,
      category: parsed.category as AiConversationCategory,
      confidence,
      severity: parsed.severity as AiConversationSeverity,
      reason,
    };
  }

  /* Notification admin sur signal HIGH uniquement (infra existante,
   * un type dédié, destinataires = ADMIN actifs — jamais le client, jamais
   * le technicien, jamais dans la conversation). Best-effort tracé. */
  private async notifyAdminsIfSevere(flag: {
    id: string;
    demandeId: string;
    messageId: string;
    senderRole: string;
    category: string;
    confidence: number;
    severity: string;
    reason: string | null;
    createdAt: Date;
  }): Promise<void> {
    if (flag.severity !== 'HIGH') return;
    try {
      const admins = await this.prisma.user.findMany({
        where: { role: 'ADMIN', isActive: true },
        select: { id: true },
      });
      for (const admin of admins) {
        await this.prisma.notification.create({
          data: {
            userId: admin.id,
            demandeId: flag.demandeId,
            type: 'CONVERSATION_FLAG',
            title: `Signal conversation ${flag.category} (${flag.severity})`,
            message:
              `Signal ${flag.category}, sévérité ${flag.severity}, confiance ${flag.confidence}. ` +
              `Message ${flag.messageId} (auteur ${flag.senderRole}), demande ${flag.demandeId}.` +
              (flag.reason ? ` ${flag.reason}` : ''),
          },
        });
      }
      this.logger.log(`Signal conversationnel ${flag.id} notifié à ${admins.length} admin(s).`);
    } catch (error) {
      this.logger.warn(
        `Notification admin impossible pour le signal ${flag.id} : ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }.`,
      );
    }
  }

  /* IA-9 — consultation admin (filtres + pagination, message + demande
   * joints pour la revue ; le contenu du message est visible admin car
   * déjà accessible via la supervision des missions). */
  async getFlagsForAdmin(
    query: { status?: string; category?: string; severity?: string; demandeId?: string; senderId?: string; page?: number; limit?: number },
    now: Date = new Date(),
  ) {
    void now;
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 20)), 100);
    const allowedStatuses = ['OPEN', 'REVIEWED', 'DISMISSED'];
    const where: Record<string, unknown> = {
      ...(query.status && allowedStatuses.includes(query.status) ? { status: query.status } : {}),
      ...(query.category && (AI_CONVERSATION_CATEGORIES as readonly string[]).includes(query.category)
        ? { category: query.category }
        : {}),
      ...(query.severity && (AI_CONVERSATION_SEVERITIES as readonly string[]).includes(query.severity)
        ? { severity: query.severity }
        : {}),
      ...(query.demandeId ? { demandeId: query.demandeId } : {}),
      // IA-9 — vue technicien (signaux de l'auteur, lecture seule).
      ...(query.senderId ? { senderId: query.senderId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.aiConversationFlag.count({ where: where as never }),
      this.prisma.aiConversationFlag.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          demande: { select: { id: true, reference: true, status: true, clientId: true, technicianId: true } },
          message: { select: { id: true, content: true, createdAt: true } },
          sender: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
    ]);
    return {
      items: rows.map((row) => this.toApiFlag(row)),
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /* Revue humaine admin (REVIEWED ou DISMISSED depuis OPEN uniquement ;
   * décision conservée, signal jamais supprimé). */
  async reviewFlag(
    adminId: string,
    flagId: string,
    decision: 'REVIEWED' | 'DISMISSED',
    note?: string,
    now: Date = new Date(),
  ) {
    const flag = await this.prisma.aiConversationFlag.findUnique({ where: { id: flagId } });
    if (!flag) throw new NotFoundException('Signal introuvable.');
    if (flag.status !== 'OPEN') {
      throw new BadRequestException('Ce signal a déjà été examiné.');
    }
    const updated = await this.prisma.aiConversationFlag.update({
      where: { id: flag.id },
      data: {
        status: decision,
        reviewedAt: now,
        reviewedBy: adminId,
        reviewNote: note?.trim() || null,
      },
      include: {
        demande: { select: { id: true, reference: true, status: true, clientId: true, technicianId: true } },
        message: { select: { id: true, content: true, createdAt: true } },
        sender: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    return this.toApiFlag(updated);
  }

  private toApiFlag(row: {
    id: string;
    demandeId: string;
    messageId: string;
    senderId: string;
    senderRole: string;
    category: string;
    confidence: number;
    severity: string;
    reason: string | null;
    model: string | null;
    promptVersion: number;
    status: string;
    reviewedAt: Date | null;
    reviewedBy: string | null;
    reviewNote: string | null;
    createdAt: Date;
    demande?: unknown;
    message?: unknown;
    sender?: unknown;
  }) {
    return {
      id: row.id,
      demandeId: row.demandeId,
      messageId: row.messageId,
      senderId: row.senderId,
      senderRole: row.senderRole,
      category: row.category,
      confidence: row.confidence,
      severity: row.severity,
      reason: row.reason,
      model: row.model,
      promptVersion: row.promptVersion,
      status: row.status,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      reviewedBy: row.reviewedBy,
      reviewNote: row.reviewNote,
      createdAt: row.createdAt.toISOString(),
      demande: (row.demande ?? null) as unknown,
      message: (row.message ?? null) as unknown,
      sender: (row.sender ?? null) as unknown,
    };
  }
}
