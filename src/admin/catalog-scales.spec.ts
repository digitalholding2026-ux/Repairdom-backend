import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CatalogService } from './catalog.service.js';
import { CatalogController } from './catalog.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/* IA-2 — barèmes par diagnostic (Prisma mocké, aucune base requise) :
 * agrégation min/référence/max, statuts actifs/inactifs, pagination,
 * validation des triplets, historique, garde ADMIN. Aucun appel IA. */

function catalogService(prisma: unknown) {
  return new CatalogService(prisma as PrismaService);
}

function pricing(overrides: Record<string, unknown> = {}) {
  return {
    minPrice: 30000,
    referencePrice: 35000,
    maxPrice: 40000,
    currency: 'XAF',
    isActive: true,
    updatedAt: new Date('2026-02-01T10:00:00.000Z'),
    ...overrides,
  };
}

function intervention(id: string, name: string, pricingValue: Record<string, unknown> | null, isActive = true) {
  return { id, name, isActive, pricing: pricingValue };
}

function diagnosticRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dg-1',
    name: 'Remplacement écran',
    slug: 'remplacement-ecran',
    isActive: true,
    updatedAt: new Date('2026-01-15T00:00:00.000Z'),
    problem: {
      id: 'pb-1',
      name: 'Écran cassé',
      slug: 'ecran-casse',
      domain: { id: 'd-1', name: 'Smartphone', slug: 'smartphone' },
    },
    interventions: [],
    ...overrides,
  };
}

describe('getDiagnosticScale — agrégation', () => {
  it('une intervention → min/ref/max directs, référence active', async () => {
    const prisma = {
      catalogDiagnostic: {
        findUnique: vi.fn(async () => diagnosticRow({ interventions: [intervention('i-1', 'Pose écran', pricing())] })),
      },
    };
    const scale = await catalogService(prisma).getDiagnosticScale('dg-1');
    expect(scale.domain).toMatchObject({ id: 'd-1', name: 'Smartphone' });
    expect(scale.scale).toMatchObject({ min: 30000, reference: 35000, max: 40000, currency: 'XAF' });
    expect(scale.hasActiveScale).toBe(true);
    expect(scale.scale.pricedInterventions).toBe(1);
  });

  it('plusieurs interventions → min des mins, max des maxs, ref unique ou null', async () => {
    const prisma = {
      catalogDiagnostic: {
        findUnique: vi.fn(async () =>
          diagnosticRow({
            interventions: [
              intervention('i-1', 'Pose', pricing({ minPrice: 20000, referencePrice: 35000, maxPrice: 50000 })),
              intervention('i-2', 'Calibrage', pricing({ minPrice: 10000, referencePrice: 35000, maxPrice: 30000 })),
            ],
          }),
        ),
      },
    };
    const scale = await catalogService(prisma).getDiagnosticScale('dg-1');
    expect(scale.scale).toMatchObject({ min: 10000, reference: 35000, max: 50000 });
    expect(scale.scale.pricedInterventions).toBe(2);
  });

  it('références divergentes → reference null (ambigu, jamais inventée)', async () => {
    const prisma = {
      catalogDiagnostic: {
        findUnique: vi.fn(async () =>
          diagnosticRow({
            interventions: [
              intervention('i-1', 'Pose', pricing({ referencePrice: 35000 })),
              intervention('i-2', 'Calibrage', pricing({ referencePrice: 20000 })),
            ],
          }),
        ),
      },
    };
    const scale = await catalogService(prisma).getDiagnosticScale('dg-1');
    expect(scale.scale.reference).toBeNull();
    expect(scale.scale.min).toBe(30000);
    expect(scale.scale.max).toBe(40000);
  });

  it('intervention inactive / pricing inactif / sans pricing → exclus', async () => {
    const prisma = {
      catalogDiagnostic: {
        findUnique: vi.fn(async () =>
          diagnosticRow({
            interventions: [
              intervention('i-1', 'Pose', pricing()),
              intervention('i-2', 'Vieux', pricing({ minPrice: 1000, referencePrice: 1000, maxPrice: 1000 }), false),
              intervention('i-3', 'Coupé', pricing({ minPrice: 1000, referencePrice: 1000, maxPrice: 1000, isActive: false })),
              intervention('i-4', 'Nu', null),
            ],
          }),
        ),
      },
    };
    const scale = await catalogService(prisma).getDiagnosticScale('dg-1');
    expect(scale.scale).toMatchObject({ min: 30000, reference: 35000, max: 40000 });
    expect(scale.scale.pricedInterventions).toBe(1);
    expect(scale.scale.totalInterventions).toBe(4);
    expect(scale.hasActiveScale).toBe(true);
  });

  it('diagnostic inactif → barème visible mais hasActiveScale=false', async () => {
    const prisma = {
      catalogDiagnostic: {
        findUnique: vi.fn(async () =>
          diagnosticRow({ isActive: false, interventions: [intervention('i-1', 'Pose', pricing())] }),
        ),
      },
    };
    const scale = await catalogService(prisma).getDiagnosticScale('dg-1');
    expect(scale.scale.min).toBe(30000);
    expect(scale.hasActiveScale).toBe(false);
  });

  it('aucun barème → scale null, hasActiveScale=false', async () => {
    const prisma = {
      catalogDiagnostic: {
        findUnique: vi.fn(async () => diagnosticRow({ interventions: [intervention('i-1', 'Pose', null)] })),
      },
    };
    const scale = await catalogService(prisma).getDiagnosticScale('dg-1');
    expect(scale.scale).toMatchObject({ min: null, reference: null, max: null });
    expect(scale.hasActiveScale).toBe(false);
  });

  it('diagnostic inexistant → 404', async () => {
    const prisma = { catalogDiagnostic: { findUnique: vi.fn(async () => null) } };
    await expect(catalogService(prisma).getDiagnosticScale('nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('listDiagnosticScales — pagination et filtres', () => {
  function prismaWith(rows: unknown[]) {
    return {
      catalogDiagnostic: {
        count: vi.fn(async () => rows.length),
        findMany: vi.fn(async (args: { skip?: number; take?: number }) => {
          const { skip = 0, take } = args ?? {};
          return take === undefined ? (rows as never[]).slice(skip) : (rows as never[]).slice(skip, skip + take);
        }),
      },
    };
  }

  const row = (id: string, name: string, active: boolean, priced: boolean) =>
    diagnosticRow({
      id,
      name,
      isActive: active,
      interventions: priced ? [intervention(`${id}-i`, `${name} pose`, pricing())] : [],
    });

  it('pagination serveur : page/limit/total/pages', async () => {
    const rows = [row('a', 'Alpha', true, true), row('b', 'Beta', true, true), row('c', 'Gamma', true, false)];
    const result = await catalogService(prismaWith(rows)).listDiagnosticScales({ page: 1, limit: 2 });
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(3);
    expect(result.pages).toBe(2);
    const second = await catalogService(prismaWith(rows)).listDiagnosticScales({ page: 2, limit: 2 });
    expect(second.items).toHaveLength(1);
  });

  it('filtre hasScale : avec et sans barème actif', async () => {
    const rows = [row('a', 'Alpha', true, true), row('b', 'Beta', true, false), row('c', 'Gamma', false, true)];
    const withScale = await catalogService(prismaWith(rows)).listDiagnosticScales({ hasScale: true });
    expect(withScale.items.map((i) => i.id).sort()).toEqual(['a']);
    const without = await catalogService(prismaWith(rows)).listDiagnosticScales({ hasScale: false });
    expect(without.items.map((i) => i.id).sort()).toEqual(['b', 'c']);
  });

  it('requête transmise : recherche, domaine, actif', async () => {
    const prisma = prismaWith([]);
    await catalogService(prisma).listDiagnosticScales({
      search: 'écran',
      domainId: 'd-1',
      active: true,
      page: 1,
      limit: 20,
    });
    const where = (prisma.catalogDiagnostic.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where.problem).toEqual({ domainId: 'd-1' });
    expect(where.isActive).toBe(true);
    expect(where.OR).toHaveLength(3);
  });
});

describe('validation des triplets (assertPricingValid via create/update)', () => {
  function createPrisma() {
    const histories: unknown[] = [];
    return {
      histories,
      catalogIntervention: {
        // Scope modèle (MODÈLE + CATÉGORIE) : l'intervention appartient à
        // une catégorie rattachée à un modèle précis.
        findUnique: vi.fn(async () => ({
          id: 'i-1',
          diagnostic: { id: 'dg-1', problem: { id: 'pb-1', name: 'Afficheur', modelId: 'm-1' } },
        })),
      },
      pricing: {
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: unknown }) => ({ id: 'p-1', ...data })),
      },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
        cb({
          pricing: {
            create: vi.fn(async ({ data }: { data: unknown }) => ({ id: 'p-1', ...data })),
          },
          pricingHistory: { create: vi.fn(async ({ data }: { data: unknown }) => { histories.push(data); return data; }) },
        }),
      ),
    };
  }

  it.each([
    ['négatif', { minPrice: -100, referencePrice: 35000, maxPrice: 40000 }],
    ['min > référence', { minPrice: 40000, referencePrice: 35000, maxPrice: 45000 }],
    ['référence > max', { minPrice: 30000, referencePrice: 50000, maxPrice: 45000 }],
    ['min > max', { minPrice: 50000, referencePrice: null, maxPrice: 40000 }],
  ])('%s rejeté', async (_label, prices) => {
    const prisma = createPrisma();
    await expect(
      catalogService(prisma).createPricing({ interventionId: 'i-1', ...prices } as never, 'admin-1'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('barème vide rejeté, triplet valide historisé (anciennes + nouvelles valeurs)', async () => {
    const prisma = createPrisma();
    await expect(
      catalogService(prisma).createPricing({ interventionId: 'i-1' } as never, 'admin-1'),
    ).rejects.toMatchObject({ status: 400 });
    await catalogService(prisma).createPricing(
      { interventionId: 'i-1', minPrice: 30000, referencePrice: 35000, maxPrice: 40000 } as never,
      'admin-1',
    );
    expect(prisma.histories).toHaveLength(1);
    const entry = prisma.histories[0] as { previousValues: Record<string, unknown>; newValues: Record<string, unknown>; adminId: string };
    expect(entry.previousValues.minPrice).toBeNull();
    expect(entry.newValues).toMatchObject({ minPrice: 30000, referencePrice: 35000, maxPrice: 40000 });
    expect(entry.adminId).toBe('admin-1');
  });
});

describe('permissions : routes barèmes réservées ADMIN', () => {
  it('CatalogController porte @Roles(ADMIN) au niveau classe', async () => {
    const { Roles } = await import('../auth/roles.decorator.js');
    void Roles;
    const metadata = Reflect.getMetadata('roles', CatalogController);
    expect(metadata).toEqual(['ADMIN']);
  });
});
