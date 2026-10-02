import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiGatewayService } from './ai-gateway.service.js';
import { AiConfig } from './ai.config.js';
import { AiPricingCheckService } from './ai-pricing-check.service.js';
import { clampLimit, clampPage, pageCount, parseSince } from './ai-list-query.js';

/* IA-5 — correspondance entre un diagnostic libre technicien et un
 * CatalogDiagnostic existant (ANALYTIQUE uniquement).
 *
 * Règles absolues :
 * - le diagnostic libre (texte, audio, mode MANUAL, devis) n'est JAMAIS
 *   modifié, réécrit ni requalifié par le mapping ;
 * - l'IA sélectionne UNIQUEMENT parmi les candidats réels transmis
 *   (jamais d'ID inventé accepté) ;
 * - tout échec → UNMATCHED/UNCERTAIN tracé, JAMAIS bloquant (ni devis,
 *   ni diagnostic, ni workflow) ;
 * - appel déclenché après enregistrement du diagnostic, idempotent
 *   (une ligne par diagnostic, rejouée sans nouvel appel) ;
 * - audio brut jamais envoyé (texte seul, nature audio éventuelle).
 *
 * Seuil/timeout : centralisés `AiConfig` (partagés avec IA-4). */

export const AI_DIAGNOSIS_MATCH_PROMPT_VERSION = 1;
export const AI_DIAGNOSIS_MATCH_MAX_CANDIDATES = 40;

export type AiDiagnosisMatchLabel = 'MATCHED' | 'UNCERTAIN' | 'UNMATCHED';

export interface AiDiagnosisMatchOutcome {
  diagnosticId: string;
  classification: AiDiagnosisMatchLabel;
  catalogDiagnosticId: string | null;
  confidence: number | null;
  model: string | null;
  reason: string;
}

const MATCH_LABELS: readonly AiDiagnosisMatchLabel[] = ['MATCHED', 'UNCERTAIN', 'UNMATCHED'];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

interface MatchCandidate {
  id: string;
  name: string;
  problemName: string;
  modelName: string | null;
  domainId: string;
  domainName: string;
}

@Injectable()
export class AiDiagnosisMatchService {
  private readonly logger = new Logger(AiDiagnosisMatchService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: AiGatewayService,
    private readonly aiConfig: AiConfig,
    private readonly pricingCheck: AiPricingCheckService,
  ) {}

  /** Mappe un diagnostic libre vers le catalogue (idempotent, non bloquant
   *  sauf diagnostic inconnu/inaccessible = erreur programmeur). */
  async mapFreeDiagnostic(
    actor: { userId: string; role: string },
    demandeId: string,
    diagnosticId: string,
  ): Promise<AiDiagnosisMatchOutcome> {
    const diagnostic = await this.prisma.diagnostic.findFirst({
      where: { id: diagnosticId, demandeId },
      select: {
        id: true,
        content: true,
        recommendation: true,
        justification: true,
        notes: true,
        audioStoragePath: true,
        technicianId: true,
        demande: {
          select: {
            id: true,
            clientId: true,
            technicianId: true,
            domainId: true,
            brandId: true,
            modelId: true,
            category: true,
          },
        },
      },
    });
    if (!diagnostic) throw new NotFoundException('Diagnostic introuvable.');
    const allowed =
      (actor.role === 'TECHNICIAN' && diagnostic.demande.technicianId === actor.userId) ||
      (actor.role === 'CLIENT' && diagnostic.demande.clientId === actor.userId) ||
      actor.role === 'ADMIN';
    if (!allowed) throw new NotFoundException('Diagnostic introuvable.');

    const existing = await this.prisma.diagnosticCatalogMatch.findUnique({
      where: { diagnosticId: diagnostic.id },
    });
    if (existing) return this.toOutcome(diagnostic.id, existing);
    if (!this.aiConfig.enabled) {
      return this.persistFallback(diagnostic.id, 'AI_DISABLED');
    }

    const candidates = await this.loadCandidates(diagnostic.demande.domainId, {
      brandId: diagnostic.demande.brandId ?? null,
      modelId: diagnostic.demande.modelId ?? null,
    });
    if (candidates.length === 0) {
      return this.persistFallback(diagnostic.id, 'NO_CANDIDATE');
    }
    let parsed: Record<string, unknown>;
    try {
      const completion = await this.gateway.completeJson<unknown>({
        caller: 'AiDiagnosisMatch',
        messages: [
          { role: 'system', content: this.systemPrompt(candidates) },
          { role: 'user', content: this.userPrompt(diagnostic) },
        ],
        timeoutMs: this.aiConfig.classificationTimeoutMs,
        correlationId: diagnostic.id,
      });
      const record = asRecord(completion.result);
      if (!record) return this.persistFallback(diagnostic.id, 'INVALID_RESPONSE');
      parsed = record;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'AI_UPSTREAM';
      return this.persistFallback(diagnostic.id, code === 'AI_TERMINAL' ? 'REJECTED' : 'UPSTREAM');
    }
    return this.persistValidated(diagnostic.id, diagnostic.demande.domainId, candidates, parsed);
  }

  /* Candidats réels : diagnostics ACTIFS, restreints au domaine de la
   * demande quand il est connu (relations existantes, bornés à 40, sans
   * moteur de recherche parallèle). Contexte modèle : les diagnostics dont
   * la catégorie est scopée AU MODÈLE DE LA MISSION passent en premier et
   * portent le nom du modèle dans leur libellé — le mapping identifie ainsi
   * « Afficheur + iPhone 11 », pas un « Afficheur » global (IA-6 résout
   * ensuite le barème exact-modèle). Sans modèle mission : ordre historique,
   * libellé « tous modèles ».
   * Chantier catalogue source de vérité : quand le modèle est connu, le
   * périmètre modèle est chargé EN PREMIER (requête dédiée) puis complété
   * par le domaine jusqu'à 40 — l'IA raisonne prioritairement sur les
   * catégories du modèle concerné, jamais sur tout le catalogue. */
  private async loadCandidates(
    domainId: string | null,
    mission?: { brandId: string | null; modelId: string | null },
  ): Promise<MatchCandidate[]> {
    // Périmètre modèle d'abord (exact-modèle), puis complément domaine.
    if (mission?.modelId && domainId) {
      const scoped = await this.prisma.catalogDiagnostic.findMany({
        where: { isActive: true, problem: { domainId, modelId: mission.modelId } },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        take: AI_DIAGNOSIS_MATCH_MAX_CANDIDATES,
        select: {
          id: true,
          name: true,
          problem: {
            select: {
              name: true,
              domainId: true,
              slug: true,
              modelId: true,
              brandId: true,
              domain: { select: { name: true } },
              brand: { select: { name: true } },
              model: { select: { name: true } },
            },
          },
        },
      });
      if (scoped.length >= AI_DIAGNOSIS_MATCH_MAX_CANDIDATES) {
        return this.toCandidates(scoped);
      }
      const rest = await this.prisma.catalogDiagnostic.findMany({
        where: {
          isActive: true,
          problem: { domainId },
          id: { notIn: scoped.map((r) => r.id) },
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        take: AI_DIAGNOSIS_MATCH_MAX_CANDIDATES - scoped.length,
        select: {
          id: true,
          name: true,
          problem: {
            select: {
              name: true,
              domainId: true,
              slug: true,
              modelId: true,
              brandId: true,
              domain: { select: { name: true } },
              brand: { select: { name: true } },
              model: { select: { name: true } },
            },
          },
        },
      });
      return this.toCandidates([...scoped, ...rest], mission);
    }
    const rows = await this.prisma.catalogDiagnostic.findMany({
      where: {
        isActive: true,
        ...(domainId ? { problem: { domainId } } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      take: AI_DIAGNOSIS_MATCH_MAX_CANDIDATES,
      select: {
        id: true,
        name: true,
        problem: {
          select: {
            name: true,
            domainId: true,
            slug: true,
            modelId: true,
            brandId: true,
            domain: { select: { name: true } },
            brand: { select: { name: true } },
            model: { select: { name: true } },
          },
        },
      },
    });
    const rank = (row: (typeof rows)[number]): number => {
      const problemModelId = row.problem?.modelId ?? null;
      const problemBrandId = row.problem?.brandId ?? null;
      if (mission?.modelId && problemModelId === mission.modelId) return 0;
      if (mission?.brandId && problemBrandId === mission.brandId && problemModelId === null) return 1;
      if (problemModelId === null && problemBrandId === null) return 2;
      return 3;
    };
    return this.toCandidates([...rows].sort((a, b) => rank(a) - rank(b)), mission);
  }

  private toCandidates(
    rows: Array<{
      id: string;
      name: string;
      problem: {
        name: string;
        domainId: string;
        modelId: string | null;
        brandId: string | null;
        domain: { name: string };
        brand: { name: string } | null;
        model: { name: string } | null;
      };
    }>,
    mission?: { brandId: string | null; modelId: string | null },
  ): MatchCandidate[] {
    const rank = (row: (typeof rows)[number]): number => {
      const problemModelId = row.problem?.modelId ?? null;
      const problemBrandId = row.problem?.brandId ?? null;
      if (mission?.modelId && problemModelId === mission.modelId) return 0;
      if (mission?.brandId && problemBrandId === mission.brandId && problemModelId === null) return 1;
      if (problemModelId === null && problemBrandId === null) return 2;
      return 3;
    };
    return [...rows]
      .sort((a, b) => rank(a) - rank(b))
      .map((row) => ({
        id: row.id,
        name: row.name,
        problemName: row.problem.name,
        modelName: row.problem?.model?.name ?? row.problem?.brand?.name ?? null,
        domainId: row.problem.domainId,
        domainName: row.problem.domain.name,
      }));
  }

  private systemPrompt(candidates: MatchCandidate[]): string {
    const lines = candidates.map(
      (c) =>
        `- ${c.id} : ${c.name} (catégorie : ${c.problemName}, modèle : ${c.modelName ?? 'tous modèles'}, domaine : ${c.domainName})`,
    );
    return [
      'Tu associes un diagnostic libre de technicien à un diagnostic du catalogue Relio.',
      'Réponds UNIQUEMENT en JSON strict, sans texte autour, avec ce schéma exact :',
      '{"catalogDiagnosticId": "uuid-ou-null", "confidence": 0.0, "classification": "MATCHED", "reason": "courte justification"}',
      'Règles : "classification" vaut MATCHED, UNCERTAIN ou UNMATCHED.',
      '"confidence" est entre 0 et 1. "catalogDiagnosticId" doit être un id de la liste ci-dessous (MATCHED uniquement), ou null (UNCERTAIN/UNMATCHED).',
      'Diagnostics existants :',
      ...lines,
    ].join('\n');
  }

  private userPrompt(diagnostic: {
    content: string;
    recommendation: string | null;
    justification: string | null;
    notes: string | null;
    audioStoragePath: string | null;
  }): string {
    const lines = [`Diagnostic : ${diagnostic.content.slice(0, 2000)}`];
    if (diagnostic.recommendation?.trim()) lines.push(`Recommandation : ${diagnostic.recommendation.trim().slice(0, 500)}`);
    if (diagnostic.justification?.trim()) lines.push(`Justification : ${diagnostic.justification.trim().slice(0, 500)}`);
    if (diagnostic.notes?.trim()) lines.push(`Notes : ${diagnostic.notes.trim().slice(0, 500)}`);
    if (diagnostic.audioStoragePath) lines.push('Note vocale : présente (non transcrite, informative uniquement).');
    return lines.join('\n');
  }

  /* Valide : JSON, label, ID parmi les candidats + actif + cohérent domaine,
   * confiance ≥ seuil → MATCHED ; parsable mais faible → UNCERTAIN ;
   * sinon → UNMATCHED. Persiste dans tous les cas (traçabilité). */
  private async persistValidated(
    diagnosticId: string,
    demandeDomainId: string | null,
    candidates: MatchCandidate[],
    parsed: Record<string, unknown>,
  ): Promise<AiDiagnosisMatchOutcome> {
    const classification = MATCH_LABELS.includes(parsed.classification as AiDiagnosisMatchLabel)
      ? (parsed.classification as AiDiagnosisMatchLabel)
      : null;
    const confidence =
      typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.min(Math.max(parsed.confidence, 0), 1)
        : null;
    let catalogDiagnosticId: string | null = null;
    let reason = 'INVALID_RESPONSE';
    if (typeof parsed.catalogDiagnosticId === 'string' && parsed.catalogDiagnosticId.trim()) {
      const candidate = candidates.find((c) => c.id === parsed.catalogDiagnosticId);
      if (!candidate) {
        reason = 'UNKNOWN_DIAGNOSTIC';
      } else if (demandeDomainId && candidate.domainId !== demandeDomainId) {
        reason = 'DOMAIN_MISMATCH';
      } else {
        const fresh = await this.prisma.catalogDiagnostic.findUnique({
          where: { id: candidate.id },
          select: { id: true, isActive: true },
        });
        if (!fresh || !fresh.isActive) {
          reason = 'INACTIVE_DIAGNOSTIC';
        } else {
          catalogDiagnosticId = candidate.id;
          reason = 'OK';
        }
      }
    }
    const usable =
      classification === 'MATCHED' &&
      catalogDiagnosticId !== null &&
      confidence !== null &&
      confidence >= this.aiConfig.classificationMinConfidence;
    const label: AiDiagnosisMatchLabel = usable
      ? 'MATCHED'
      : classification === 'UNCERTAIN' ||
          (classification === 'MATCHED' && confidence !== null && confidence < this.aiConfig.classificationMinConfidence)
        ? 'UNCERTAIN'
        : 'UNMATCHED';
    const row = await this.prisma.diagnosticCatalogMatch.upsert({
      where: { diagnosticId },
      create: {
        diagnosticId,
        catalogDiagnosticId: usable ? catalogDiagnosticId : null,
        confidence,
        classification: label,
        model: this.aiConfig.model,
        promptVersion: AI_DIAGNOSIS_MATCH_PROMPT_VERSION,
        reason: usable ? 'OK' : reason === 'OK' ? 'LOW_CONFIDENCE' : reason,
      },
      update: {},
    });
    // IA-6 — mapping arrivé APRÈS le devis : contrôle les devis MANUAL
    // PENDING encore sans contrôle (fire-and-forget, jamais bloquant).
    if (usable) {
      void this.pricingCheck.evaluatePendingQuotesForMatch(diagnosticId).catch(() => undefined);
    }
    return this.toOutcome(diagnosticId, row);
  }

  private async persistFallback(diagnosticId: string, reason: string): Promise<AiDiagnosisMatchOutcome> {
    const row = await this.prisma.diagnosticCatalogMatch.upsert({
      where: { diagnosticId },
      create: {
        diagnosticId,
        catalogDiagnosticId: null,
        confidence: null,
        classification: 'UNMATCHED',
        model: null,
        promptVersion: AI_DIAGNOSIS_MATCH_PROMPT_VERSION,
        reason,
      },
      update: {},
    });
    this.logger.warn(`Mapping IA indisponible pour ${diagnosticId} (${reason}) : diagnostic libre inchangé.`);
    return this.toOutcome(diagnosticId, row);
  }

  /* IA-9 — lecture admin paginée des mappings (visualisation seule :
   * le diagnostic libre reste la source de vérité, jamais remplacé ici). */
  async listForAdmin(query: {
    classification?: string;
    demandeId?: string;
    since?: string;
    page?: number;
    limit?: number;
  }) {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const since = parseSince(query.since);
    const where: Record<string, unknown> = {
      ...(query.classification && (MATCH_LABELS as readonly string[]).includes(query.classification)
        ? { classification: query.classification }
        : {}),
      ...(query.demandeId ? { diagnostic: { demandeId: query.demandeId } } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.diagnosticCatalogMatch.count({ where: where as never }),
      this.prisma.diagnosticCatalogMatch.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          diagnostic: { select: { id: true, demandeId: true, content: true, createdAt: true } },
          catalogDiagnostic: { select: { id: true, name: true } },
        },
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        diagnosticId: row.diagnosticId,
        catalogDiagnosticId: row.catalogDiagnosticId,
        catalogDiagnosticName: row.catalogDiagnostic?.name ?? null,
        classification: row.classification,
        confidence: row.confidence,
        model: row.model,
        promptVersion: row.promptVersion,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
        diagnostic: row.diagnostic,
      })),
      total,
      page,
      limit,
      pages: pageCount(total, limit),
    };
  }

  private toOutcome(
    diagnosticId: string,
    row: {
      classification: string;
      catalogDiagnosticId: string | null;
      confidence: number | null;
      model: string | null;
      reason: string | null;
    },
  ): AiDiagnosisMatchOutcome {
    return {
      diagnosticId,
      classification: (MATCH_LABELS as readonly string[]).includes(row.classification)
        ? (row.classification as AiDiagnosisMatchLabel)
        : 'UNMATCHED',
      catalogDiagnosticId: row.catalogDiagnosticId,
      confidence: row.confidence,
      model: row.model,
      reason: row.reason ?? 'UNKNOWN',
    };
  }
}
