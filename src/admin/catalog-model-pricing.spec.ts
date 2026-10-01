import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { CatalogService } from './catalog.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/* Tarification scopée au modèle (MODÈLE + CATÉGORIE) — Prisma mocké :
 * - un nouveau tarif n'existe que sous une catégorie rattachée à un modèle
 *   précis (jamais de barème global ambigu) ;
 * - même slug sur deux modèles → deux barèmes indépendants (isolation +
 *   historiques séparés) ;
 * - barème de catégorie agrégé (getProblemScale) : min des mins, max des
 *   maxs, référence unique ou null. `assertPricingValid` reste la seule
 *   autorité de validation (aucune duplication). */

function catalogService(prisma: unknown) {
  return new CatalogService(prisma as PrismaService);
}

function interventionWithProblem(
  interventionId: string,
  problem: { id: string; name: string; modelId: string | null; brandId?: string | null },
) {
  return {
    id: interventionId,
    diagnostic: { id: 'dg-1', problem },
  };
}

function createPrisma(problem: { id: string; name: string; modelId: string | null; brandId?: string | null }) {
  const histories: unknown[] = [];
  const pricingUpdate = vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'p-1', ...data }));
  return {
    histories,
    pricingUpdate,
    catalogIntervention: { findUnique: vi.fn(async () => interventionWithProblem('i-1', problem)) },
    pricing: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'p-1', ...data })),
      update: pricingUpdate,
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        pricing: {
          create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'p-1', ...data })),
          update: pricingUpdate,
        },
        pricingHistory: {
          create: vi.fn(async ({ data }: { data: unknown }) => {
            histories.push(data);
            return data;
          }),
        },
      }),
    ),
  };
}

const VALID = { interventionId: 'i-1', minPrice: 25000, referencePrice: 35000, maxPrice: 50000 };

describe('unicité MODÈLE + CATÉGORIE — création', () => {
  it('iPhone 11 + Afficheur (modelId renseigné) → autorisé', async () => {
    const prisma = createPrisma({ id: 'pb-11', name: 'Afficheur', modelId: 'm-11' });
    const pricing = await catalogService(prisma).createPricing({ ...VALID } as never, 'admin-1');
    expect(pricing).toMatchObject({ minPrice: 25000, referencePrice: 35000, maxPrice: 50000 });
  });

  it('catégorie générique (modelId null) → deuxième cas refusé : aucun nouveau barème global', async () => {
    const prisma = createPrisma({ id: 'pb-gen', name: 'Afficheur', modelId: null });
    await expect(catalogService(prisma).createPricing({ ...VALID } as never, 'admin-1')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('catégorie marque seule (brandId sans modelId) → refusé', async () => {
    const prisma = createPrisma({ id: 'pb-ios', name: 'Afficheur', modelId: null, brandId: 'b-ios' });
    await expect(catalogService(prisma).createPricing({ ...VALID } as never, 'admin-1')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('deuxième tarif sur la même intervention → refusé (un seul tarif actif)', async () => {
    const prisma = createPrisma({ id: 'pb-11', name: 'Afficheur', modelId: 'm-11' });
    (prisma.pricing.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: 'p-old' });
    await expect(catalogService(prisma).createPricing({ ...VALID } as never, 'admin-1')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('iPhone XR + Afficheur (même slug, autre modèle) → autorisé (barème propre)', async () => {
    const prisma = createPrisma({ id: 'pb-xr', name: 'Afficheur', modelId: 'm-xr' });
    const pricing = await catalogService(prisma).createPricing(
      { ...VALID, minPrice: 20000, referencePrice: 30000, maxPrice: 45000 } as never,
      'admin-1',
    );
    expect(pricing).toMatchObject({ minPrice: 20000, referencePrice: 30000, maxPrice: 45000 });
  });
});

describe('isolation — modifier iPhone 11 ne touche pas iPhone XR', () => {
  it('updatePricing cible la seule intervention et historise son pricing', async () => {
    const prisma = createPrisma({ id: 'pb-11', name: 'Afficheur', modelId: 'm-11' });
    (prisma.pricing.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: 'p-11',
      minPrice: 25000,
      referencePrice: 35000,
      maxPrice: 50000,
      travelFee: null,
      serviceFee: null,
      currency: 'XAF',
      priceMode: 'fixed',
      isActive: true,
    });
    await catalogService(prisma).updatePricing('i-11', { referencePrice: 36000 } as never, 'admin-1');
    expect(prisma.pricingUpdate).toHaveBeenCalledTimes(1);
    expect(prisma.pricingUpdate).toHaveBeenCalledWith({
      where: { interventionId: 'i-11' },
      data: { referencePrice: 36000 },
    });
    expect(prisma.histories).toHaveLength(1);
    const entry = prisma.histories[0] as { pricingId: string; previousValues: { referencePrice: number }; newValues: { referencePrice: number } };
    expect(entry.pricingId).toBe('p-11');
    expect(entry.previousValues.referencePrice).toBe(35000);
    expect(entry.newValues.referencePrice).toBe(36000);
  });
});

describe('historique — un historique par modèle', () => {
  it('création iPhone 11 → history(previous=nulls, new=valeurs, adminId)', async () => {
    const prisma = createPrisma({ id: 'pb-11', name: 'Afficheur', modelId: 'm-11' });
    await catalogService(prisma).createPricing({ ...VALID } as never, 'admin-9');
    expect(prisma.histories).toHaveLength(1);
    const entry = prisma.histories[0] as {
      pricingId: string;
      adminId: string;
      previousValues: Record<string, unknown>;
      newValues: Record<string, unknown>;
    };
    expect(entry.adminId).toBe('admin-9');
    expect(entry.previousValues.minPrice).toBeNull();
    expect(entry.newValues).toMatchObject({ minPrice: 25000, referencePrice: 35000, maxPrice: 50000 });
  });
});

describe('getProblemScale — barème de la catégorie pour son modèle', () => {
  function problemPrisma(problem: Record<string, unknown>, diagnostics: unknown[]) {
    return {
      problem: {
        findUnique: vi.fn(async () => ({ ...problem, diagnostics })),
      },
    };
  }

  const base = {
    id: 'pb-11',
    name: 'Afficheur',
    slug: 'afficheur',
    isActive: true,
    domain: { id: 'd-1', name: 'Smartphone', slug: 'smartphone' },
    brand: { id: 'b-ios', name: 'iOS' },
    model: { id: 'm-11', name: 'iPhone 11' },
  };

  const priced = (id: string, min: number | null, ref: number | null, max: number | null, active = true) => ({
    id,
    name: `Tarif ${id}`,
    slug: id,
    isActive: true,
    pricing: { id: `p-${id}`, minPrice: min, referencePrice: ref, maxPrice: max, isActive: active },
  });

  it('agrège min des mins / max des maxs, référence unique', async () => {
    const prisma = problemPrisma(base, [
      { id: 'dg-1', name: 'Dalle', slug: 'dalle', isActive: true, interventions: [priced('a', 25000, 35000, 50000)] },
      { id: 'dg-2', name: 'Tactile', slug: 'tactile', isActive: true, interventions: [priced('b', 20000, 35000, 45000)] },
    ]);
    const scale = await catalogService(prisma).getProblemScale('pb-11');
    expect(scale.model).toMatchObject({ id: 'm-11', name: 'iPhone 11' });
    expect(scale.scale).toMatchObject({ min: 20000, reference: 35000, max: 50000, currency: 'XAF' });
    expect(scale.hasActiveScale).toBe(true);
  });

  it('références divergentes → reference null (jamais inventée)', async () => {
    const prisma = problemPrisma(base, [
      { id: 'dg-1', name: 'Dalle', slug: 'dalle', isActive: true, interventions: [priced('a', 25000, 35000, 50000)] },
      { id: 'dg-2', name: 'Tactile', slug: 'tactile', isActive: true, interventions: [priced('b', 20000, 30000, 45000)] },
    ]);
    const scale = await catalogService(prisma).getProblemScale('pb-11');
    expect(scale.scale.reference).toBeNull();
    expect(scale.scale.min).toBe(20000);
    expect(scale.scale.max).toBe(50000);
  });

  it('inactifs exclus ; catégorie inactive → hasActiveScale=false', async () => {
    const prisma = problemPrisma(
      { ...base, isActive: false },
      [{ id: 'dg-1', name: 'Dalle', slug: 'dalle', isActive: true, interventions: [priced('a', 25000, 35000, 50000)] }],
    );
    const scale = await catalogService(prisma).getProblemScale('pb-11');
    expect(scale.hasActiveScale).toBe(false);
    expect(scale.scale.min).toBe(25000);
  });

  it('catégorie inconnue → 404', async () => {
    const prisma = { problem: { findUnique: vi.fn(async () => null) } };
    await expect(catalogService(prisma).getProblemScale('nope')).rejects.toMatchObject({ status: 404 });
  });
});
