import { describe, expect, it, vi } from 'vitest';
import { CatalogContextService } from './catalog-context.service.js';
import { comparePriceToScale } from './ai-pricing-check.service.js';

/* Catalogue source de vérité IA : recherche ciblée, vérification backend,
 * barème exact-modèle, contexte demande. L'IA propose, le backend vérifie. */

function prismaWith(models: unknown[], problem: unknown, demande: unknown) {
  return {
    deviceModel: {
      findMany: vi.fn(async () => models),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        (models as Array<{ id: string }>).find((m) => m.id === where.id)
          ? { ...(models as Array<Record<string, unknown>>).find((m) => (m as { id: string }).id === where.id), isActive: true }
          : null,
      ),
    },
    problem: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => problem),
    },
    demande: { findUnique: vi.fn(async () => demande) },
  };
}

const MODELS = [
  {
    id: 'm-12pro',
    name: 'iPhone 12 Pro',
    brand: { id: 'b-apple', name: 'Apple', domain: { id: 'd-phone', name: 'Smartphone' } },
  },
  {
    id: 'm-11',
    name: 'iPhone 11',
    brand: { id: 'b-apple', name: 'Apple', domain: { id: 'd-phone', name: 'Smartphone' } },
  },
];

const PROBLEM_AFFICHEUR = {
  id: 'p-aff',
  modelId: 'm-12pro',
  isActive: true,
  diagnostics: [
    { interventions: [{ pricing: { id: 'pr-1', minPrice: 15000, referencePrice: 25000, maxPrice: 35000, isActive: true } }] },
  ],
};

describe('catalogue source de vérité IA', () => {
  it('recherche "iPhone 12 Pro Max ne s allume plus" → iPhone 12 Pro candidat', async () => {
    const svc = new CatalogContextService(prismaWith(MODELS, null, null) as never);
    const hits = await svc.searchModels('Mon iPhone 12 Pro Max ne s allume plus correctement.');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]?.id).toBe('m-12pro');
  });

  it('ID inventé par l IA → null (UNCERTAIN/UNMATCHED, jamais bloquant)', async () => {
    const svc = new CatalogContextService(prismaWith(MODELS, null, null) as never);
    expect(await svc.verifyModel('modele-invente-xyz')).toBeNull();
  });

  it('iPhone 12 Pro + Afficheur → 15000/25000/35000, IA-6 ABOVE_MAX à 40000', async () => {
    const svc = new CatalogContextService(prismaWith(MODELS, PROBLEM_AFFICHEUR, null) as never);
    const scale = await svc.getScaleForModelCategory('m-12pro', 'p-aff');
    expect(scale).toMatchObject({ min: 15000, reference: 25000, max: 35000 });
    expect(comparePriceToScale(40000, scale!)).toMatchObject({ result: 'ABOVE_MAX' });
  });

  it('catégorie d un autre modèle → null (aucun report inter-modèles)', async () => {
    const svc = new CatalogContextService(prismaWith(MODELS, PROBLEM_AFFICHEUR, null) as never);
    // Problème scopé m-12pro demandé avec m-11 → refusé.
    const scale = await svc.getScaleForModelCategory('m-11', 'p-aff');
    expect(scale).toBeNull();
  });

  it('contexte demande : IDs + barème actuel, catalogue supprimé → NONE', async () => {
    const demande = {
      domainId: 'd-phone',
      brandId: 'b-apple',
      modelId: 'm-12pro',
      problemId: 'p-aff',
      domain: { id: 'd-phone', name: 'Smartphone', isActive: true },
      brand: { id: 'b-apple', name: 'Apple', isActive: true },
      model: { id: 'm-12pro', name: 'iPhone 12 Pro', isActive: true },
      problem: { id: 'p-aff', name: 'Afficheur', isActive: true },
    };
    const svc = new CatalogContextService(prismaWith(MODELS, PROBLEM_AFFICHEUR, demande) as never);
    const ctx = await svc.buildDemandeCatalogContext('dem-1');
    expect(ctx).toMatchObject({ catalogueId: 'd-phone', modelId: 'm-12pro', categoryId: 'p-aff', source: 'DEMANDE' });
    expect(ctx.scale).toMatchObject({ min: 15000, max: 35000 });

    const svcGone = new CatalogContextService(
      prismaWith(MODELS, PROBLEM_AFFICHEUR, {
        domainId: null,
        brandId: null,
        modelId: null,
        problemId: null,
        domain: null,
        brand: null,
        model: null,
        problem: null,
      }) as never,
    );
    const gone = await svcGone.buildDemandeCatalogContext('dem-1');
    expect(gone.source).toBe('NONE');
    expect(gone.scale).toBeNull();
  });
});
