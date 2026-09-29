import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { ALLOWED_CATEGORIES } from '../demandes/categories.js';
import { AiGatewayService } from './ai-gateway.service.js';
import { AiConfig } from './ai.config.js';

/* IA-4 — classification des demandes « Autre » (aide au dispatch).
 *
 * Règles absolues :
 * - l'IA ne choisit JAMAIS de technicien et ne modifie JAMAIS la demande
 *   (ni statut, ville, zone, ni données client) ;
 * - la donnée client (`Demande.category`) n'est JAMAIS écrasée : la
 *   proposition vit dans `DemandeClassification` (une ligne par demande,
 *   rejouée sans doublon, fallback tracé) ;
 * - tout échec (désactivée, timeout, 4xx/5xx, invalide, incohérente) →
 *   fallback, JAMAIS d'exception vers l'appelant (la création de demande
 *   ne dépend jamais de l'IA) ;
 * - données envoyées minimales : appareil, description, ville, natures de
 *   médias. JAMAIS : téléphone, adresse, GPS, email, finance, tokens.
 *
 * Seuil centralisé : `AI_CLASSIFICATION_MIN_CONFIDENCE` (défaut 0.7).
 * Timeout dédié : `AI_CLASSIFICATION_TIMEOUT_MS` (défaut 8 s, borné). */

export const AI_CLASSIFICATION_PROMPT_VERSION = 1;
export const AI_CLASSIFICATION_DEFAULT_MIN_CONFIDENCE = 0.7;
export const AI_CLASSIFICATION_DEFAULT_TIMEOUT_MS = 8_000;
export const AI_CLASSIFICATION_MAX_TIMEOUT_MS = 30_000;

export type AiClassificationLabel = 'CLASSIFIED' | 'UNCERTAIN' | 'UNCLASSIFIABLE';

export interface AiClassificationInput {
  demandeId: string;
  /** Libellé appareil (domaine/marque/modèle assemblés côté appelant). */
  deviceLabel?: string | null;
  description?: string | null;
  city?: string | null;
  /** Natures des pièces jointes (ex. ['IMAGE','AUDIO']), jamais de bytes. */
  mediaKinds?: string[];
}

export interface AiClassificationOutcome {
  demandeId: string;
  classification: AiClassificationLabel;
  domainId: string | null;
  categories: string[];
  confidence: number | null;
  model: string | null;
  reason: string;
}

const CLASSIFICATION_LABELS: readonly AiClassificationLabel[] = [
  'CLASSIFIED',
  'UNCERTAIN',
  'UNCLASSIFIABLE',
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

@Injectable()
export class AiClassificationService {
  private readonly logger = new Logger(AiClassificationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly gateway: AiGatewayService,
    private readonly aiConfig: AiConfig,
  ) {}

  get minConfidence(): number {
    return this.aiConfig.classificationMinConfidence;
  }

  get timeoutMs(): number {
    return this.aiConfig.classificationTimeoutMs;
  }

  /** Classifie une demande « Autre » (idempotent, jamais d'exception). */
  async classifyAutreDemande(input: AiClassificationInput): Promise<AiClassificationOutcome> {
    const existing = await this.prisma.demandeClassification.findUnique({
      where: { demandeId: input.demandeId },
    });
    if (existing) {
      return this.toOutcome(input.demandeId, existing);
    }
    if (!this.aiConfig.enabled) {
      return this.persistFallback(input.demandeId, 'AI_DISABLED');
    }
    let parsed: Record<string, unknown>;
    try {
      const domains = await this.prisma.serviceDomain.findMany({
        where: { isActive: true },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
      const completion = await this.gateway.completeJson<unknown>({
        caller: 'AiClassification',
        messages: [
          { role: 'system', content: this.systemPrompt(domains) },
          { role: 'user', content: this.userPrompt(input) },
        ],
        timeoutMs: this.timeoutMs,
        correlationId: input.demandeId,
      });
      const record = asRecord(completion.result);
      if (!record) return this.persistFallback(input.demandeId, 'INVALID_RESPONSE');
      parsed = record;
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'AI_UPSTREAM';
      return this.persistFallback(input.demandeId, code === 'AI_TERMINAL' ? 'REJECTED' : 'UPSTREAM');
    }
    return this.persistValidated(input.demandeId, parsed);
  }

  private systemPrompt(domains: Array<{ id: string; name: string }>): string {
    const domainLines = domains.map((domain) => `- ${domain.id} : ${domain.name}`).join('\n');
    return [
      'Tu classes une demande de dépannage pour le service Relio.',
      'Réponds UNIQUEMENT en JSON strict, sans texte autour, avec ce schéma exact :',
      '{"domainId": "uuid-ou-null", "confidence": 0.0, "suggestedCategories": [], "reason": "courte justification", "classification": "CLASSIFIED"}',
      'Règles : "classification" vaut CLASSIFIED, UNCERTAIN ou UNCLASSIFIABLE.',
      '"confidence" est entre 0 et 1. "domainId" doit être un id de la liste ci-dessous ou null.',
      '"suggestedCategories" ne contient que des valeurs de la liste des catégories.',
      'Domaines actifs Relio :',
      domainLines,
      `Catégories valides : ${ALLOWED_CATEGORIES.join(', ')}.`,
    ].join('\n');
  }

  private userPrompt(input: AiClassificationInput): string {
    const lines = [
      `Appareil : ${input.deviceLabel?.trim() || 'non renseigné'}`,
      `Description du client : ${input.description?.trim().slice(0, 1000) || 'aucune'}`,
      `Ville : ${input.city?.trim() || 'non renseignée'}`,
    ];
    if (input.mediaKinds && input.mediaKinds.length > 0) {
      lines.push(`Pièces jointes : ${[...new Set(input.mediaKinds)].join(', ')}`);
    }
    return lines.join('\n');
  }

  /* Valide la réponse (schéma, domaine actif existant, catégories réelles,
   * confiance 0..1) puis persiste. Invalide/incohérent → fallback tracé. */
  private async persistValidated(
    demandeId: string,
    parsed: Record<string, unknown>,
  ): Promise<AiClassificationOutcome> {
    const classification = CLASSIFICATION_LABELS.includes(parsed.classification as AiClassificationLabel)
      ? (parsed.classification as AiClassificationLabel)
      : null;
    const confidence =
      typeof parsed.confidence === 'number' && Number.isFinite(parsed.confidence)
        ? Math.min(Math.max(parsed.confidence, 0), 1)
        : null;
    const rawCategories = Array.isArray(parsed.suggestedCategories) ? parsed.suggestedCategories : [];
    const categories = [...new Set(rawCategories.filter((c): c is string => typeof c === 'string'))].filter((c) =>
      (ALLOWED_CATEGORIES as readonly string[]).includes(c),
    );
    let domainId: string | null = null;
    if (typeof parsed.domainId === 'string' && parsed.domainId.trim()) {
      const domain = await this.prisma.serviceDomain.findUnique({
        where: { id: parsed.domainId.trim() },
        select: { id: true, isActive: true },
      });
      if (domain && domain.isActive) domainId = domain.id;
    }
    const usable =
      classification === 'CLASSIFIED' &&
      domainId !== null &&
      confidence !== null &&
      confidence >= this.minConfidence;
    // Confiance insuffisante (réponse parsable) → UNCERTAIN (fallback) ;
    // incohérente/invalide → UNCLASSIFIABLE.
    const lowConfidence = confidence !== null && confidence < this.minConfidence;
    const label: AiClassificationLabel = usable
      ? 'CLASSIFIED'
      : classification === 'UNCERTAIN' || (classification === 'CLASSIFIED' && lowConfidence)
        ? 'UNCERTAIN'
        : 'UNCLASSIFIABLE';
    const row = await this.prisma.demandeClassification.upsert({
      where: { demandeId },
      create: {
        demandeId,
        domainId: usable ? domainId : null,
        categories: usable ? categories : [],
        confidence,
        classification: label,
        model: this.aiConfig.model,
        promptVersion: AI_CLASSIFICATION_PROMPT_VERSION,
        reason: usable
          ? 'OK'
          : !classification
            ? 'INVALID_RESPONSE'
            : lowConfidence
              ? 'LOW_CONFIDENCE'
              : 'UNKNOWN_DOMAIN',
      },
      update: {},
    });
    return this.toOutcome(demandeId, row);
  }

  private async persistFallback(demandeId: string, reason: string): Promise<AiClassificationOutcome> {
    const row = await this.prisma.demandeClassification.upsert({
      where: { demandeId },
      create: {
        demandeId,
        domainId: null,
        categories: [],
        confidence: null,
        classification: 'UNCLASSIFIABLE',
        model: null,
        promptVersion: AI_CLASSIFICATION_PROMPT_VERSION,
        reason,
      },
      update: {},
    });
    this.logger.warn(`Classification IA indisponible pour ${demandeId} (${reason}) : fallback dispatch standard.`);
    return this.toOutcome(demandeId, row);
  }

  private toOutcome(
    demandeId: string,
    row: {
      classification: string;
      domainId: string | null;
      categories: string[];
      confidence: number | null;
      model: string | null;
      reason: string | null;
    },
  ): AiClassificationOutcome {
    return {
      demandeId,
      classification: (CLASSIFICATION_LABELS as readonly string[]).includes(row.classification)
        ? (row.classification as AiClassificationLabel)
        : 'UNCLASSIFIABLE',
      domainId: row.domainId,
      categories: row.categories,
      confidence: row.confidence,
      model: row.model,
      reason: row.reason ?? 'UNKNOWN',
    };
  }
}
