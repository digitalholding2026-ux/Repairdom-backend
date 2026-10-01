import { describe, expect, it, vi } from 'vitest';
import { AiAdminService } from './ai-admin.service.js';
import { AiClassificationService } from './ai-classification.service.js';
import { AiDiagnosisMatchService } from './ai-diagnosis-match.service.js';
import { AiPricingCheckService } from './ai-pricing-check.service.js';
import { AdminController } from '../admin/admin.controller.js';

/* IA-9 — dashboard admin (visualisation seule) : compteurs factuels,
 * listes paginées/filtrées IA-4/IA-5/IA-6, permissions ADMIN, aucune
 * analyse, aucun appel provider IA, aucune écriture métier. Prisma mocké. */

function adminService(prisma: unknown) {
  // AiAdminService n'injecte QUE PrismaService : structurellement incapable
  // d'appeler le provider IA (dashboard accessible IA indisponible).
  return new AiAdminService(prisma as never);
}

describe('overview — compteurs factuels par signal', () => {
  it('agrège les statuts sans analyse ni PII', async () => {
    const prisma = {
      demandeClassification: {
        groupBy: vi.fn(async () => [
          { classification: 'CLASSIFIED', _count: { _all: 5 } },
          { classification: 'UNCERTAIN', _count: { _all: 2 } },
        ]),
        count: vi.fn(async () => 7),
      },
      diagnosticCatalogMatch: {
        groupBy: vi.fn(async () => [{ classification: 'MATCHED', _count: { _all: 3 } }]),
        count: vi.fn(async () => 4),
      },
      quotePricingCheck: {
        groupBy: vi.fn(async () => [
          { result: 'NORMAL', _count: { _all: 10 } },
          { result: 'ABOVE_MAX', _count: { _all: 1 } },
        ]),
        count: vi.fn(async () => 11),
      },
      aiWarning: { count: vi.fn(async () => 0) },
      aiConversationFlag: { count: vi.fn(async () => 0) },
    };
    const overview = (await adminService(prisma).getOverview(
      new Date('2026-10-04T00:00:00Z'),
    )) as unknown as Record<string, Record<string, unknown>>;
    expect(overview.classifications).toMatchObject({
      total: 7,
      byClassification: { CLASSIFIED: 5, UNCERTAIN: 2 },
    });
    expect(overview.mappings).toMatchObject({ total: 4, byClassification: { MATCHED: 3 } });
    expect(overview.pricingChecks).toMatchObject({
      total: 11,
      byResult: { NORMAL: 10, ABOVE_MAX: 1 },
    });
    expect(overview.warnings).toMatchObject({ total: 0, pending: 0, expiredEffective: 0 });
    expect(overview.conversationFlags).toMatchObject({ total: 0, open: 0, highOpen: 0 });
    expect(typeof overview.generatedAt).toBe('string');
    // Aucune donnée personnelle dans l'overview.
    const serialized = JSON.stringify(overview);
    for (const leak of ['phone', 'email', 'address', 'password', 'token', 'sk-or-', 'gsk-']) {
      expect(serialized.toLowerCase()).not.toContain(leak);
    }
  });

  it('EXPIRED dérivé compté sans persistance (PENDING + dueAt dépassé)', async () => {
    const prisma = {
      demandeClassification: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 0) },
      diagnosticCatalogMatch: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 0) },
      quotePricingCheck: { groupBy: vi.fn(async () => []), count: vi.fn(async () => 0) },
      aiWarning: {
        count: vi.fn(async (args?: unknown) => {
          const where = ((args ?? {}) as { where?: Record<string, unknown> }).where ?? {};
          if (where.status === 'PENDING' && where.dueAt) return 4;
          if (where.status === 'PENDING') return 9;
          if (where.status === 'JUSTIFIED') return 1;
          if (where.status === 'REVIEWED') return 2;
          return 12;
        }),
      },
      aiConversationFlag: { count: vi.fn(async () => 0) },
    };
    const overview = (await adminService(prisma).getOverview()) as unknown as {
      warnings: { expiredEffective: number; pending: number; justified: number; reviewed: number; total: number };
    };
    expect(overview.warnings).toMatchObject({
      expiredEffective: 4,
      pending: 9,
      justified: 1,
      reviewed: 2,
      total: 12,
    });
    expect(prisma.aiWarning.count).toHaveBeenCalledWith({
      where: { status: 'PENDING', dueAt: { lt: expect.any(Date) } },
    });
  });
});

describe('IA-4 — liste admin des classifications', () => {
  function classificationService(options: {
    rows?: Array<Record<string, unknown>>;
    count?: number;
    domains?: Array<{ id: string; name: string }>;
  } = {}) {
    const prisma = {
      demandeClassification: {
        count: vi.fn(async () => options.count ?? 0),
        findUnique: vi.fn(async () => null),
        findMany: vi.fn(
          async () =>
            (options.rows ?? [
              {
                id: 'c-1',
                demandeId: 'd-1',
                classification: 'CLASSIFIED',
                domainId: 'dom-1',
                categories: ['plomberie'],
                confidence: 0.9,
                model: 'm',
                promptVersion: 1,
                reason: 'OK',
                createdAt: new Date('2026-10-01T00:00:00Z'),
                demande: { id: 'd-1', reference: 'RD-1', status: 'PENDING', category: 'autre' },
              },
            ]) as never,
        ),
      },
      serviceDomain: {
        findMany: vi.fn(async () => (options.domains ?? [{ id: 'dom-1', name: 'Plomberie' }]) as never),
      },
    };
    return {
      service: new AiClassificationService(prisma as never, {} as never, {} as never, {
        classificationMinConfidence: 0.7,
        classificationTimeoutMs: 8000,
      } as never),
      prisma,
    };
  }

  it('filtre classification + pagination, domaine résolu sans N+1', async () => {
    const { service, prisma } = classificationService({ count: 1 });
    const result = (await service.listForAdmin({ classification: 'CLASSIFIED', page: 1, limit: 20 })) as unknown as Record<string, unknown>;
    expect(result).toMatchObject({ total: 1, page: 1, limit: 20, pages: 1 });
    expect(prisma.demandeClassification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 20 }),
    );
    // Un seul appel domaines pour toute la page (pas de N+1).
    expect(prisma.serviceDomain.findMany).toHaveBeenCalledTimes(1);
    expect((result.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      domainName: 'Plomberie',
    });
  });

  it('classification invalide ignorée (pas de 400, pas de fuite)', async () => {
    const { service, prisma } = classificationService();
    await service.listForAdmin({ classification: 'HACKED' });
    expect(prisma.demandeClassification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: {} }),
    );
  });
});

describe('IA-5 — liste admin des mappings', () => {
  function matchService(rows?: Array<Record<string, unknown>>, count = 0) {
    const prisma = {
      diagnosticCatalogMatch: {
        count: vi.fn(async () => count),
        findMany: vi.fn(async () => (rows ?? []) as never),
      },
    };
    return {
      service: new AiDiagnosisMatchService(prisma as never, {} as never, {} as never, {} as never),
      prisma,
    };
  }

  it('filtre MATCHED + diagnostic libre joint (source de vérité intacte)', async () => {
    const rows = [
      {
        id: 'm-1',
        diagnosticId: 'dg-1',
        catalogDiagnosticId: 'cd-1',
        classification: 'MATCHED',
        confidence: 0.88,
        model: 'm',
        promptVersion: 1,
        reason: 'OK',
        createdAt: new Date('2026-10-02T00:00:00Z'),
        diagnostic: { id: 'dg-1', demandeId: 'd-1', content: 'Fuite sous évier', createdAt: new Date() },
        catalogDiagnostic: { id: 'cd-1', name: 'Fuite évier' },
      },
    ];
    const { service } = matchService(rows, 1);
    const result = (await service.listForAdmin({ classification: 'MATCHED' })) as unknown as Record<string, unknown>;
    expect(result).toMatchObject({ total: 1 });
    expect((result.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      catalogDiagnosticName: 'Fuite évier',
    });
  });
});

describe('IA-6 — liste admin des contrôles (snapshot figé)', () => {
  function checkService() {
    const stored = {
      id: 'chk-1',
      quoteId: 'q-1',
      demandeId: 'd-1',
      diagnosticId: 'dg-1',
      catalogDiagnosticId: 'cd-1',
      proposedPrice: 85000,
      minAtCheck: 30000,
      referenceAtCheck: 50000,
      maxAtCheck: 80000,
      result: 'ABOVE_MAX',
      pricingIds: ['p-1'],
      deviationAmount: 5000,
      deviationBps: 1000,
      reason: 'ABOVE_MAX',
      createdAt: new Date('2026-10-03T00:00:00Z'),
      quote: { id: 'q-1', amount: 85000, currency: 'XAF', status: 'PENDING', technicianId: 'tech-1' },
    };
    const prisma = {
      quote: { findUnique: vi.fn(async () => null), findMany: vi.fn(async () => []) },
      quotePricingCheck: {
        findUnique: vi.fn(async () => null),
        upsert: vi.fn(async () => stored as never),
        findMany: vi.fn(async () => [] as never),
        count: vi.fn(async () => 1),
      },
      diagnosticCatalogMatch: { findUnique: vi.fn(async () => null) },
      catalogDiagnostic: { findUnique: vi.fn(async () => null) },
    };
    // findMany liste : retourne la ligne stockée (montants figés).
    (prisma.quotePricingCheck.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([stored] as never);
    return {
      service: new AiPricingCheckService(prisma as never, { ensureWarningForCheck: vi.fn() } as never),
      prisma,
      stored,
    };
  }

  it('filtre result + snapshot historique affiché tel quel (XAF, jamais recalculé)', async () => {
    const { service, stored } = checkService();
    const result = (await service.listForAdmin({ result: 'ABOVE_MAX', page: 1, limit: 20 })) as unknown as Record<string, unknown>;
    expect(result).toMatchObject({ total: 1 });
    expect((result.items as Array<Record<string, unknown>>)[0]).toMatchObject({
      proposedPrice: stored.proposedPrice,
      minAtCheck: stored.minAtCheck,
      maxAtCheck: stored.maxAtCheck,
      deviationAmount: stored.deviationAmount,
      result: 'ABOVE_MAX',
    });
  });

  it('filtre technicien via devis (sans faire confiance au frontend)', async () => {
    const { service, prisma } = checkService();
    await service.listForAdmin({ technicianId: 'tech-1' });
    expect(prisma.quotePricingCheck.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ quote: { technicianId: 'tech-1' } }) }),
    );
  });
});

describe('permissions — routes IA-9 réservées ADMIN', () => {
  it('AdminController porte @Roles(ADMIN) au niveau classe', () => {
    // Même garde que IA-7/IA-8 : JwtAuthGuard + RolesGuard, aucun endpoint public.
    const roles = Reflect.getMetadata('roles', AdminController) as string[] | undefined;
    expect(roles).toEqual(['ADMIN']);
    const guards = Reflect.getMetadata('__guards__', AdminController) as unknown[] | undefined;
    expect(Array.isArray(guards)).toBe(true);
    expect(guards?.length).toBeGreaterThan(0);
  });
});
