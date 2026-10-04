import { describe, expect, it, vi } from 'vitest';
import { CatalogService } from './catalog.service.js';

/* Normalisation anti-doublons du catalogue (Prisma simulé, aucun réseau) :
 * slugs normalisés (casse/espaces) + garde sur le nom insensible à la
 * casse dans le périmètre (domaine, marque, modèle, catégorie). */

function mockPrisma(store: {
  domains?: Array<Record<string, unknown>>;
  brands?: Array<Record<string, unknown>>;
  models?: Array<Record<string, unknown>>;
  problems?: Array<Record<string, unknown>>;
}) {
  const matchScope = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'NOT') return (row.id as string) !== (value as { id: string }).id;
      if (value !== null && typeof value === 'object' && 'equals' in (value as Record<string, unknown>)) {
        const { equals, mode } = value as { equals: string; mode?: string };
        const actual = String(row[key] ?? '');
        return mode === 'insensitive' ? actual.toLowerCase() === equals.toLowerCase() : actual === equals;
      }
      return row[key] === value;
    });
  const findFirst = (rows: Array<Record<string, unknown>> = []) =>
    vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((row) => matchScope(row, where)) ?? null);
  const findUnique = (rows: Array<Record<string, unknown>> = [], key = 'id') =>
    vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
      if ('slug' in where) return rows.find((row) => row.slug === where.slug) ?? null;
      return rows.find((row) => row[key] === where[key]) ?? null;
    });
  return {
    serviceDomain: {
      findUnique: findUnique(store.domains),
      findFirst: findFirst(store.domains),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'd-1', ...data })),
    },
    deviceBrand: {
      findUnique: findUnique(store.brands),
      findFirst: findFirst(store.brands),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'b-1', ...data })),
    },
    deviceModel: {
      findUnique: findUnique(store.models),
      findFirst: findFirst(store.models),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'm-1', ...data })),
    },
    problem: {
      findUnique: findUnique(store.problems),
      findFirst: findFirst(store.problems),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'p-1', ...data })),
    },
  };
}

describe('normalisation des slugs (casse + espaces)', () => {
  it('« Ma Marque » → « ma-marque » (espaces et casse normalisés)', async () => {
    const prisma = mockPrisma({ domains: [{ id: 'd-1' }], brands: [] });
    const service = new CatalogService(prisma as never);
    const result = await service.createBrand({ domainId: 'd-1', name: 'Ma Marque', slug: 'Ma Marque' });
    expect((result as Record<string, unknown>).slug).toBe('ma-marque');
  });

  it('slug existant sous une autre casse → 400', async () => {
    const prisma = mockPrisma({
      domains: [{ id: 'd-1' }],
      brands: [{ id: 'b-1', domainId: 'd-1', name: 'TECNO', slug: 'tecno' }],
    });
    const service = new CatalogService(prisma as never);
    await expect(
      service.createBrand({ domainId: 'd-1', name: 'Autre', slug: 'TECNO' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('slug vide après normalisation → 400', async () => {
    const prisma = mockPrisma({ domains: [{ id: 'd-1' }], brands: [] });
    const service = new CatalogService(prisma as never);
    await expect(
      service.createBrand({ domainId: 'd-1', name: '!!', slug: '!!!' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('garde anti-doublon sur le nom (insensible à la casse)', () => {
  it('« tecno » refusé quand « TECNO » existe dans le domaine', async () => {
    const prisma = mockPrisma({
      domains: [{ id: 'd-1' }],
      brands: [{ id: 'b-1', domainId: 'd-1', name: 'TECNO', slug: 'tecno' }],
    });
    const service = new CatalogService(prisma as never);
    await expect(
      service.createBrand({ domainId: 'd-1', name: '  tecno  ', slug: 'tecno-2' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('même nom dans un autre domaine → accepté', async () => {
    const prisma = mockPrisma({
      domains: [{ id: 'd-1' }, { id: 'd-2' }],
      brands: [{ id: 'b-1', domainId: 'd-1', name: 'TECNO', slug: 'tecno' }],
    });
    const service = new CatalogService(prisma as never);
    const result = await service.createBrand({ domainId: 'd-2', name: 'TECNO', slug: 'tecno' });
    expect((result as Record<string, unknown>).name).toBe('TECNO');
  });

  it('renommage vers un nom existant → 400', async () => {
    const prisma = mockPrisma({
      brands: [
        { id: 'b-1', domainId: 'd-1', name: 'TECNO', slug: 'tecno' },
        { id: 'b-2', domainId: 'd-1', name: 'Samsung', slug: 'samsung' },
      ],
    });
    const service = new CatalogService(prisma as never);
    await expect(service.updateBrand('b-2', { name: 'tecno' })).rejects.toMatchObject({ status: 400 });
  });

  it('modèle : « spark 20 » et « Spark-20 » → conflit dans la marque', async () => {
    const prisma = mockPrisma({
      brands: [{ id: 'b-1', domainId: 'd-1' }],
      models: [{ id: 'm-1', brandId: 'b-1', name: 'Spark 20', slug: 'spark-20' }],
    });
    const service = new CatalogService(prisma as never);
    await expect(
      service.createModel({ brandId: 'b-1', name: 'Spark-20', slug: 'Spark-20' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('catégorie : doublon de nom dans le périmètre → 400', async () => {
    const prisma = mockPrisma({
      domains: [{ id: 'd-1' }],
      problems: [{ id: 'p-1', domainId: 'd-1', brandId: null, modelId: null, name: 'Ecran casse', slug: 'ecran-casse' }],
    });
    const service = new CatalogService(prisma as never);
    await expect(
      service.createProblem({ domainId: 'd-1', name: '  ECRAN CASSE ', slug: 'autre-slug' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
