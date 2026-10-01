import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AiWarningService } from './ai-warning.service.js';
import { clampLimit, clampPage, pageCount, parseSince } from './ai-list-query.js';

/* IA-6 — surveillance DÉTERMINISTE des tarifs (signal, jamais de blocage).
 *
 * Règles absolues :
 * - AUCUN appel provider IA ici (comparaison prix ↔ barème en code pur ;
 *   fonctionne même si le provider est totalement indisponible) ;
 * - l'IA (mapping IA-5) identifie le diagnostic, le CODE compare ;
 * - `null` n'est JAMAIS traité comme 0 (bornes réellement disponibles) ;
 * - snapshot IMMUABLE par devis (création unique, jamais réécrit) ;
 * - devis, montants, statuts et workflows intacts (aucun blocage).
 *
 * Résultats : NORMAL | ABOVE_MAX | BELOW_MIN | UNCERTAIN | NO_BAREME. */

export type PricingCheckResult = 'NORMAL' | 'ABOVE_MAX' | 'BELOW_MIN' | 'UNCERTAIN' | 'NO_BAREME';

const PRICING_CHECK_RESULTS: readonly PricingCheckResult[] = [
  'NORMAL',
  'ABOVE_MAX',
  'BELOW_MIN',
  'UNCERTAIN',
  'NO_BAREME',
];

export interface PriceScale {
  min: number | null;
  reference: number | null;
  max: number | null;
}

export interface PriceComparison {
  result: PricingCheckResult;
  deviationAmount: number | null;
  /** Écart relatif en points de base (entier, null sans référence > 0). */
  deviationBps: number | null;
}

/** Compare un prix entier XAF à des bornes réellement disponibles
 *  (entiers ou null — jamais de flottants monétaires). */
export function comparePriceToScale(proposedPrice: number, scale: PriceScale): PriceComparison {
  const { min, reference, max } = scale;
  if (max !== null && proposedPrice > max) {
    const deviation = proposedPrice - max;
    return {
      result: 'ABOVE_MAX',
      deviationAmount: deviation,
      deviationBps: reference !== null && reference > 0 ? Math.round((deviation * 10000) / reference) : null,
    };
  }
  if (min !== null && proposedPrice < min) {
    const deviation = min - proposedPrice;
    return {
      result: 'BELOW_MIN',
      deviationAmount: deviation,
      deviationBps: reference !== null && reference > 0 ? Math.round((deviation * 10000) / reference) : null,
    };
  }
  return { result: 'NORMAL', deviationAmount: null, deviationBps: null };
}

@Injectable()
export class AiPricingCheckService {
  private readonly logger = new Logger(AiPricingCheckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly warnings: AiWarningService,
  ) {}

  /** Contrôle un devis MANUAL (création unique, idempotent, non bloquant
   *  pour l'appelant qui attrape les erreurs). `null` = devis non-MANUAL
   *  (parcours CATALOG intact, non concerné). */
  async evaluateManualQuote(quoteId: string) {
    const quote = await this.prisma.quote.findUnique({
      where: { id: quoteId },
      select: { id: true, demandeId: true, diagnosticId: true, amount: true, source: true },
    });
    if (!quote) throw new NotFoundException('Devis introuvable.');
    if (quote.source !== 'MANUAL') return null;
    const existing = await this.prisma.quotePricingCheck.findUnique({ where: { quoteId } });
    if (existing) return existing;
    if (!quote.diagnosticId) {
      return this.persist(quote, null, null, { result: 'NO_BAREME', reason: 'NO_DIAGNOSTIC' });
    }
    const match = await this.prisma.diagnosticCatalogMatch.findUnique({
      where: { diagnosticId: quote.diagnosticId },
    });
    if (!match || match.classification !== 'MATCHED' || !match.catalogDiagnosticId) {
      return this.persist(quote, quote.diagnosticId, null, { result: 'NO_BAREME', reason: 'NO_MATCH' });
    }
    const catalogDiagnostic = await this.prisma.catalogDiagnostic.findUnique({
      where: { id: match.catalogDiagnosticId },
      select: {
        id: true,
        isActive: true,
        interventions: {
          where: { isActive: true },
          select: { id: true, pricing: true },
        },
      },
    });
    if (!catalogDiagnostic || !catalogDiagnostic.isActive) {
      return this.persist(quote, quote.diagnosticId, match.catalogDiagnosticId, {
        result: 'UNCERTAIN',
        reason: 'INACTIVE_SCALE',
      });
    }
    const pricings = catalogDiagnostic.interventions
      .map((intervention) => intervention.pricing)
      .filter((pricing): pricing is NonNullable<typeof pricing> => pricing !== null && pricing.isActive);
    if (pricings.length === 0) {
      return this.persist(quote, quote.diagnosticId, match.catalogDiagnosticId, {
        result: 'NO_BAREME',
        reason: 'NO_PRICING',
      });
    }
    const mins = pricings.map((p) => p.minPrice).filter((v): v is number => v !== null);
    const maxs = pricings.map((p) => p.maxPrice).filter((v): v is number => v !== null);
    const refs = pricings.map((p) => p.referencePrice).filter((v): v is number => v !== null);
    const scale: PriceScale = {
      min: mins.length > 0 ? Math.min(...mins) : null,
      reference: refs.length === 1 ? refs[0] : null,
      max: maxs.length > 0 ? Math.max(...maxs) : null,
    };
    if (scale.min === null && scale.reference === null && scale.max === null) {
      return this.persist(quote, quote.diagnosticId, match.catalogDiagnosticId, {
        result: 'NO_BAREME',
        reason: 'NO_BOUNDS',
        pricingIds: pricings.map((p) => p.id),
      });
    }
    const comparison = comparePriceToScale(quote.amount, scale);
    return this.persist(quote, quote.diagnosticId, match.catalogDiagnosticId, {
      result: comparison.result,
      pricingIds: pricings.map((p) => p.id),
      partial: { ...scale },
      deviation: comparison,
    });
  }

  /* Mapping IA-5 arrivé APRÈS le devis : contrôle les devis MANUAL PENDING
   * du diagnostic encore sans contrôle (le devis accepté/clos ne bouge
   * plus ; un contrôle existant n'est jamais réécrit). */
  async evaluatePendingQuotesForMatch(diagnosticId: string): Promise<void> {
    const quotes = await this.prisma.quote.findMany({
      where: { diagnosticId, source: 'MANUAL', status: 'PENDING', pricingCheck: { is: null } },
      select: { id: true },
    });
    for (const quote of quotes) {
      try {
        await this.evaluateManualQuote(quote.id);
      } catch (error) {
        this.logger.warn(
          `Contrôle tarifaire impossible pour ${quote.id} : ${
            error instanceof Error ? error.message : 'erreur inconnue'
          }.`,
        );
      }
    }
  }

  /* IA-9 — lecture des contrôles d'une demande (service seul, aucune route
   * exposée en IA-6). */
  async getChecksForDemande(demandeId: string) {
    return this.prisma.quotePricingCheck.findMany({
      where: { demandeId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /* IA-9 — lecture admin paginée des contrôles (visualisation seule :
   * snapshot historique figé, jamais recalculé depuis le barème actuel). */
  async listForAdmin(query: {
    result?: string;
    demandeId?: string;
    technicianId?: string;
    since?: string;
    page?: number;
    limit?: number;
  }) {
    const page = clampPage(query.page);
    const limit = clampLimit(query.limit);
    const since = parseSince(query.since);
    const where: Record<string, unknown> = {
      ...(query.result && PRICING_CHECK_RESULTS.includes(query.result as PricingCheckResult)
        ? { result: query.result }
        : {}),
      ...(query.demandeId ? { demandeId: query.demandeId } : {}),
      ...(query.technicianId ? { quote: { technicianId: query.technicianId } } : {}),
      ...(since ? { createdAt: { gte: since } } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.quotePricingCheck.count({ where: where as never }),
      this.prisma.quotePricingCheck.findMany({
        where: where as never,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          quote: {
            select: {
              id: true,
              amount: true,
              currency: true,
              status: true,
              technicianId: true,
              demande: { select: { id: true, reference: true, status: true } },
            },
          },
        },
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        quoteId: row.quoteId,
        demandeId: row.demandeId,
        diagnosticId: row.diagnosticId,
        catalogDiagnosticId: row.catalogDiagnosticId,
        // Snapshot figé au moment du devis (jamais recalculé).
        proposedPrice: row.proposedPrice,
        minAtCheck: row.minAtCheck,
        referenceAtCheck: row.referenceAtCheck,
        maxAtCheck: row.maxAtCheck,
        result: row.result,
        pricingIds: row.pricingIds,
        deviationAmount: row.deviationAmount,
        deviationBps: row.deviationBps,
        reason: row.reason,
        createdAt: row.createdAt.toISOString(),
        quote: row.quote,
      })),
      total,
      page,
      limit,
      pages: pageCount(total, limit),
    };
  }

  private async persist(
    quote: { id: string; demandeId: string; amount: number; diagnosticId: string | null },
    diagnosticId: string | null,
    catalogDiagnosticId: string | null,
    check:
      | { result: PricingCheckResult; pricingIds: string[]; partial: PriceScale; deviation: PriceComparison; reason?: string }
      | { result: 'UNCERTAIN' | 'NO_BAREME'; reason: string; pricingIds?: string[] },
  ) {
    const row = await this.prisma.quotePricingCheck.upsert({
      where: { quoteId: quote.id },
      create: {
        quoteId: quote.id,
        demandeId: quote.demandeId,
        diagnosticId,
        catalogDiagnosticId,
        proposedPrice: quote.amount,
        minAtCheck: 'partial' in check ? check.partial.min : null,
        referenceAtCheck: 'partial' in check ? check.partial.reference : null,
        maxAtCheck: 'partial' in check ? check.partial.max : null,
        result: check.result,
        pricingIds: check.pricingIds ?? [],
        deviationAmount: 'deviation' in check ? check.deviation.deviationAmount : null,
        deviationBps: 'deviation' in check ? check.deviation.deviationBps : null,
        reason: check.reason ?? (check.result === 'NORMAL' ? 'OK' : check.result),
      },
      update: {},
    });
    // Log sans montant (donnée financière) : ids + résultat + motif.
    this.logger.log(
      `Contrôle tarifaire ${quote.id} : ${row.result} (${row.reason ?? '—'}, pricings=${row.pricingIds.length}).`,
    );
    // IA-7 — signal d'avertissement sur ABOVE_MAX (best-effort, jamais
    // bloquant : le devis est déjà créé et accepté dans son workflow).
    if (row.result === 'ABOVE_MAX' && this.warnings) {
      try {
        await this.warnings.ensureWarningForCheck({
          id: row.id,
          quoteId: quote.id,
          demandeId: quote.demandeId,
          diagnosticId: quote.diagnosticId,
          result: row.result,
          proposedPrice: row.proposedPrice,
          maxAtCheck: row.maxAtCheck,
          deviationAmount: row.deviationAmount,
        });
      } catch (error) {
        this.logger.warn(
          `Avertissement impossible pour le contrôle ${row.id} : ${
            error instanceof Error ? error.message : 'erreur inconnue'
          }.`,
        );
      }
    }
    return row;
  }
}
