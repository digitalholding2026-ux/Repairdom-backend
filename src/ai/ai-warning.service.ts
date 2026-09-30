import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/* IA-7 — avertissements tarifaires (surveillance progressive, JAMAIS une
 * sanction automatique : aucun blocage, aucune suspension, aucune décision
 * disciplinaire — toute décision importante reste humaine).
 *
 * - Créé uniquement sur contrôle ABOVE_MAX (NORMAL/UNCERTAIN/NO_BAREME :
 *   rien ; BELOW_MIN : signal IA-6 seul, jamais d'avertissement) ;
 * - idempotent par contrôle (pricingCheckId unique, rejoué sans doublon) ;
 * - expiration LAZY : EXPIRED dérivé (PENDING + dueAt dépassé), sans timer ;
 * - justification 48 h calculée backend (horodatage serveur uniquement) ;
 * - niveaux déterministes 0/1/2/3 (niveau 3 = réexamen humain, pas de
 *   suspension) ; aucun appel OpenRouter (déterministe pur). */

export const AI_WARNING_JUSTIFICATION_DUE_HOURS = 48;
export const AI_WARNING_JUSTIFICATION_MIN_LENGTH = 10;
export const AI_WARNING_JUSTIFICATION_MAX_LENGTH = 2000;

/* Seuils de surveillance (compte d'avertissements ABOVE_MAX du technicien,
 * tous statuts confondus — historique immuable). Explicites et documentés :
 * niveau 3 = examen humain requis, jamais de suspension automatique. */
export const AI_WARNING_LEVEL_1_COUNT = 1;
export const AI_WARNING_LEVEL_2_COUNT = 2;
export const AI_WARNING_LEVEL_3_COUNT = 4;

export type AiWarningEffectiveStatus = 'PENDING' | 'JUSTIFIED' | 'EXPIRED' | 'REVIEWED';

/** Statut effectif (EXPIRED dérivé, jamais persisté par timer). */
export function effectiveWarningStatus(
  warning: { status: string; dueAt: Date },
  now: Date = new Date(),
): AiWarningEffectiveStatus {
  if (warning.status === 'JUSTIFIED') return 'JUSTIFIED';
  if (warning.status === 'REVIEWED') return 'REVIEWED';
  if (warning.dueAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'PENDING';
}

/** Niveau de surveillance déterministe (comptage, jamais de LLM). */
export function surveillanceLevelForCount(count: number): 0 | 1 | 2 | 3 {
  if (count >= AI_WARNING_LEVEL_3_COUNT) return 3;
  if (count >= AI_WARNING_LEVEL_2_COUNT) return 2;
  if (count >= AI_WARNING_LEVEL_1_COUNT) return 1;
  return 0;
}

@Injectable()
export class AiWarningService {
  private readonly logger = new Logger(AiWarningService.name);

  constructor(private readonly prisma: PrismaService) {}

  /* Crée l'avertissement d'un contrôle ABOVE_MAX + notification technicien
   * (infra existante). Idempotent (rejoué sans doublon). Ne lève jamais
   * vers l'appelant métier (best-effort tracé). */
  async ensureWarningForCheck(check: {
    id: string;
    quoteId: string;
    demandeId: string;
    diagnosticId: string | null;
    result: string;
    proposedPrice?: number | null;
    maxAtCheck?: number | null;
    deviationAmount?: number | null;
  }): Promise<unknown> {
    if (check.result !== 'ABOVE_MAX') return null;
    const existing = await this.prisma.aiWarning.findUnique({
      where: { pricingCheckId: check.id },
    });
    if (existing) return existing;
    try {
      const quote = await this.prisma.quote.findUnique({
        where: { id: check.quoteId },
        select: { id: true, technicianId: true, amount: true },
      });
      if (!quote) return null;
      // Contexte tarifaire pour le message factuel (§4 : montant proposé,
      // maximum du barème, 48 h, poursuite normale — jamais de qualification
      // du comportement). Transmis par l'appelant IA-6, sinon relu du check.
      let proposedPrice = check.proposedPrice ?? quote.amount;
      let maxAtCheck = check.maxAtCheck ?? null;
      let deviationAmount = check.deviationAmount ?? null;
      if ((maxAtCheck === null || deviationAmount === null) && this.prisma.quotePricingCheck) {
        const row = await (this.prisma.quotePricingCheck as unknown as {
          findUnique: (args: unknown) => Promise<{
            proposedPrice: number;
            maxAtCheck: number | null;
            deviationAmount: number | null;
          } | null>;
        }).findUnique({ where: { id: check.id } });
        if (row) {
          proposedPrice = row.proposedPrice;
          maxAtCheck = row.maxAtCheck;
          deviationAmount = row.deviationAmount;
        }
      }
      const createdAt = new Date();
      const warning = await this.prisma.aiWarning.create({
        data: {
          technicianId: quote.technicianId,
          demandeId: check.demandeId,
          quoteId: check.quoteId,
          diagnosticId: check.diagnosticId,
          pricingCheckId: check.id,
          warningType: 'PRICE_ABOVE_MAX',
          status: 'PENDING',
          dueAt: new Date(createdAt.getTime() + AI_WARNING_JUSTIFICATION_DUE_HOURS * 3600_000),
        },
      });
      // Message neutre et factuel : écart au barème, montants, justification
      // complémentaire 48 h, poursuite normale. Aucun terme accusatoire.
      const parts = [
        `Votre proposition (${proposedPrice} XAF) dépasse le barème applicable`,
      ];
      if (maxAtCheck !== null) {
        parts[0] += ` (maximum ${maxAtCheck} XAF`;
        if (deviationAmount !== null) parts[0] += `, soit un écart de ${deviationAmount} XAF`;
        parts[0] += ')';
      }
      parts[0] += '.';
      await this.prisma.notification.create({
        data: {
          userId: quote.technicianId,
          demandeId: check.demandeId,
          type: 'PRICING_WARNING',
          title: 'Écart au barème à justifier',
          message:
            `${parts[0]} Une justification complémentaire est demandée sous 48 h. ` +
            'Vous pouvez poursuivre le processus normalement.',
        },
      });
      this.logger.log(
        `Avertissement tarifaire ${warning.id} (devis ${check.quoteId}, 48 h` +
          `${deviationAmount !== null ? `, écart ${deviationAmount}` : ''}).`,
      );
      return warning;
    } catch (error) {
      // Doublon concurrent (P2002) : relire l'existant, sinon tracer.
      const code = (error as { code?: string }).code;
      if (code === 'P2002') {
        return this.prisma.aiWarning.findUnique({ where: { pricingCheckId: check.id } });
      }
      this.logger.warn(
        `Avertissement impossible pour le contrôle ${check.id} : ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }.`,
      );
      return null;
    }
  }

  /* Avertissements du technicien connecté (statut effectif inclus). */
  async listMyWarnings(userId: string, now: Date = new Date()) {
    const rows = await this.prisma.aiWarning.findMany({
      where: { technicianId: userId },
      orderBy: { createdAt: 'desc' },
      include: {
        demande: { select: { id: true, reference: true, status: true } },
        quote: {
          select: {
            id: true,
            amount: true,
            currency: true,
            status: true,
            pricingCheck: {
              select: {
                proposedPrice: true,
                minAtCheck: true,
                referenceAtCheck: true,
                maxAtCheck: true,
                result: true,
                deviationAmount: true,
                deviationBps: true,
              },
            },
          },
        },
      },
    });
    return rows.map((row) => this.toApiWarning(row, now));
  }

  /* Justification par le technicien propriétaire (PENDING, ou tardive après
   * échéance — marquée tardive, décision à l'admin). */
  async justifyWarning(userId: string, warningId: string, text: string, now: Date = new Date()) {
    const warning = await this.prisma.aiWarning.findUnique({ where: { id: warningId } });
    if (!warning || warning.technicianId !== userId) {
      throw new NotFoundException('Avertissement introuvable.');
    }
    if (warning.status === 'REVIEWED') {
      throw new BadRequestException('Cet avertissement a déjà été examiné.');
    }
    if (warning.status === 'JUSTIFIED') {
      throw new BadRequestException('Cet avertissement est déjà justifié.');
    }
    const justification = text?.trim() ?? '';
    if (justification.length < AI_WARNING_JUSTIFICATION_MIN_LENGTH) {
      throw new BadRequestException(
        `Justification trop courte (${AI_WARNING_JUSTIFICATION_MIN_LENGTH} caractères minimum).`,
      );
    }
    if (justification.length > AI_WARNING_JUSTIFICATION_MAX_LENGTH) {
      throw new BadRequestException(
        `Justification trop longue (${AI_WARNING_JUSTIFICATION_MAX_LENGTH} caractères maximum).`,
      );
    }
    const late = warning.dueAt.getTime() <= now.getTime();
    const updated = await this.prisma.aiWarning.update({
      where: { id: warning.id },
      data: {
        status: 'JUSTIFIED',
        justification,
        justifiedAt: now,
        isLateJustification: late,
      },
      include: {
        demande: { select: { id: true, reference: true, status: true } },
        quote: { select: { id: true, amount: true, currency: true, status: true } },
      },
    });
    return this.toApiWarning(updated, now);
  }

  /* Revue humaine admin (décision conservée, événement initial intact). */
  async reviewWarning(adminId: string, warningId: string, note?: string, now: Date = new Date()) {
    const warning = await this.prisma.aiWarning.findUnique({ where: { id: warningId } });
    if (!warning) throw new NotFoundException('Avertissement introuvable.');
    if (warning.status === 'REVIEWED') {
      throw new BadRequestException('Cet avertissement est déjà examiné.');
    }
    const updated = await this.prisma.aiWarning.update({
      where: { id: warning.id },
      data: {
        status: 'REVIEWED',
        reviewedAt: now,
        reviewedBy: adminId,
        reviewNote: note?.trim() || null,
      },
      include: {
        demande: { select: { id: true, reference: true, status: true } },
        quote: { select: { id: true, amount: true, currency: true, status: true } },
        technician: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    return this.toApiWarning(updated, now);
  }

  /* IA-9 — consultation admin (filtres + pagination, niveaux inclus). */
  async getWarningsForAdmin(
    query: { technicianId?: string; status?: string; page?: number; limit?: number },
    now: Date = new Date(),
  ) {
    const page = Math.max(1, Math.floor(query.page ?? 1));
    const limit = Math.min(Math.max(1, Math.floor(query.limit ?? 20)), 100);
    const where: Record<string, unknown> = {
      ...(query.technicianId ? { technicianId: query.technicianId } : {}),
      ...(query.status ? { status: query.status } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.aiWarning.count({ where: where as never }),
      this.prisma.aiWarning.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          demande: { select: { id: true, reference: true, status: true, clientId: true } },
          quote: {
            select: {
              id: true,
              amount: true,
              currency: true,
              status: true,
              pricingCheck: {
                select: {
                  proposedPrice: true,
                  minAtCheck: true,
                  referenceAtCheck: true,
                  maxAtCheck: true,
                  result: true,
                  deviationAmount: true,
                  deviationBps: true,
                },
              },
            },
          },
          technician: { select: { id: true, firstName: true, lastName: true } },
        },
      }),
    ]);
    const items = rows.map((row) => this.toApiWarning(row, now));
    const levels = new Map<string, number>();
    for (const row of rows) {
      if (!levels.has(row.technicianId)) {
        levels.set(row.technicianId, await this.getSurveillanceLevel(row.technicianId));
      }
    }
    return {
      items: items.map((item, index) => ({
        ...item,
        surveillanceLevel: levels.get(rows[index].technicianId) ?? 0,
      })),
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
    };
  }

  /* Niveau de surveillance d'un technicien (comptage ABOVE_MAX, jamais LLM). */
  async getSurveillanceLevel(technicianId: string): Promise<0 | 1 | 2 | 3> {
    const count = await this.prisma.aiWarning.count({
      where: { technicianId, warningType: 'PRICE_ABOVE_MAX' },
    });
    return surveillanceLevelForCount(count);
  }

  private toApiWarning(
    row: {
      id: string;
      warningType: string;
      status: string;
      dueAt: Date;
      justification: string | null;
      justifiedAt: Date | null;
      isLateJustification: boolean;
      reviewedAt: Date | null;
      reviewedBy: string | null;
      reviewNote: string | null;
      createdAt: Date;
      quoteId: string;
      demandeId: string;
      diagnosticId: string | null;
      pricingCheckId: string;
      demande?: unknown;
      quote?: unknown;
      technician?: unknown;
    },
    now: Date,
  ) {
    // Signal admin exploitable (§13-14) : barème snapshot + écart joints via
    // quote.pricingCheck (jamais de notification client, jamais de donnée
    // inutile). Absent en historique mocké → null, jamais d'erreur.
    const quote = (row.quote ?? null) as {
      pricingCheck?: {
        proposedPrice: number;
        minAtCheck: number | null;
        referenceAtCheck: number | null;
        maxAtCheck: number | null;
        result: string;
        deviationAmount: number | null;
        deviationBps: number | null;
      } | null;
    } | null;
    return {
      id: row.id,
      warningType: row.warningType,
      status: effectiveWarningStatus({ status: row.status, dueAt: row.dueAt }, now),
      storedStatus: row.status,
      dueAt: row.dueAt.toISOString(),
      justification: row.justification,
      justifiedAt: row.justifiedAt ? row.justifiedAt.toISOString() : null,
      isLateJustification: row.isLateJustification,
      reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
      reviewedBy: row.reviewedBy,
      reviewNote: row.reviewNote,
      createdAt: row.createdAt.toISOString(),
      quoteId: row.quoteId,
      demandeId: row.demandeId,
      diagnosticId: row.diagnosticId,
      pricingCheckId: row.pricingCheckId,
      pricing: quote?.pricingCheck ?? null,
      demande: (row.demande ?? null) as unknown,
      quote: (row.quote ?? null) as unknown,
      technician: (row.technician ?? null) as unknown,
    };
  }
}
