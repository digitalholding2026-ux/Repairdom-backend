import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/* IA-9 — agrégation du dashboard admin (VISUALISATION uniquement).
 *
 * Ce service ne fait que récupérer/compter/paginer des signaux EXISTANTS
 * (IA-4 → IA-8) : aucune analyse, aucun appel OpenRouter (le dashboard
 * reste accessible même IA indisponible), aucune écriture, aucun score
 * global de risque (les faits individuels restent visibles par onglet).
 * Requêtes parallèles, relations bornées, index existants — pas de N+1. */

function countBy<T extends string>(groups: Array<{ _count: { _all: number } } & Record<string, T | unknown>>, key: string) {
  const by: Record<string, number> = {};
  for (const group of groups) {
    const value = group[key];
    if (typeof value === 'string') by[value] = group._count._all;
  }
  return by;
}

@Injectable()
export class AiAdminService {
  constructor(private readonly prisma: PrismaService) {}

  /** Compteurs factuels par signal (backend source de vérité, jamais de
   *  statistique critique calculée côté frontend). */
  async getOverview(now: Date = new Date()) {
    const [
      classificationGroups,
      classificationTotal,
      matchGroups,
      matchTotal,
      checkGroups,
      checkTotal,
      warningPending,
      warningJustified,
      warningReviewed,
      warningExpiredEffective,
      warningTotal,
      flagOpen,
      flagReviewed,
      flagDismissed,
      flagHighOpen,
      flagTotal,
    ] = await Promise.all([
      this.prisma.demandeClassification.groupBy({ by: ['classification'], _count: { _all: true } }),
      this.prisma.demandeClassification.count(),
      this.prisma.diagnosticCatalogMatch.groupBy({ by: ['classification'], _count: { _all: true } }),
      this.prisma.diagnosticCatalogMatch.count(),
      this.prisma.quotePricingCheck.groupBy({ by: ['result'], _count: { _all: true } }),
      this.prisma.quotePricingCheck.count(),
      this.prisma.aiWarning.count({ where: { status: 'PENDING' } }),
      this.prisma.aiWarning.count({ where: { status: 'JUSTIFIED' } }),
      this.prisma.aiWarning.count({ where: { status: 'REVIEWED' } }),
      // EXPIRED dérivé (PENDING + échéance dépassée), jamais persisté.
      this.prisma.aiWarning.count({ where: { status: 'PENDING', dueAt: { lt: now } } }),
      this.prisma.aiWarning.count(),
      this.prisma.aiConversationFlag.count({ where: { status: 'OPEN' } }),
      this.prisma.aiConversationFlag.count({ where: { status: 'REVIEWED' } }),
      this.prisma.aiConversationFlag.count({ where: { status: 'DISMISSED' } }),
      // HIGH non examinés = file prioritaire de revue humaine.
      this.prisma.aiConversationFlag.count({ where: { status: 'OPEN', severity: 'HIGH' } }),
      this.prisma.aiConversationFlag.count(),
    ]);
    return {
      classifications: {
        total: classificationTotal,
        byClassification: countBy(classificationGroups as never, 'classification'),
      },
      mappings: {
        total: matchTotal,
        byClassification: countBy(matchGroups as never, 'classification'),
      },
      pricingChecks: {
        total: checkTotal,
        byResult: countBy(checkGroups as never, 'result'),
      },
      warnings: {
        total: warningTotal,
        pending: warningPending,
        justified: warningJustified,
        reviewed: warningReviewed,
        expiredEffective: warningExpiredEffective,
      },
      conversationFlags: {
        total: flagTotal,
        open: flagOpen,
        reviewed: flagReviewed,
        dismissed: flagDismissed,
        highOpen: flagHighOpen,
      },
      generatedAt: now.toISOString(),
    };
  }
}
