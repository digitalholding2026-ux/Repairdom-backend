import { describe, expect, it } from 'vitest';
import { CatalogV2Service } from './catalog.service.js';
import { SEED_TOTALS, seedCatalogV2 } from '../../prisma/seed-catalog-data.js';

/* M1 — Catalogue v2. Le double Prisma est en mémoire mais FIDÈLE : ses upsert
 * écrivent réellement dans les tableaux et respectent la contrainte unique
 * naturelle, et ses findMany/findUnique/findFirst appliquent le `where` et
 * l'`orderBy`. Les fixtures (prix Tecno 3000/1500, items « sur devis »)
 * proviennent du vrai seed déroulé sur ce double, pas de valeurs recopiées à la
 * main — si le seed change, ces tests bougent avec lui. */

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => row[key] === value);
}

function sortRows(rows: Row[], orderBy?: Row): Row[] {
  if (!orderBy) return rows;
  const [field, dir] = Object.entries(orderBy)[0] as [string, string];
  return [...rows].sort((left, right) => {
    if (left[field] === right[field]) return 0;
    const step = left[field] < right[field] ? -1 : 1;
    return dir === 'desc' ? -step : step;
  });
}

function createCatalogDouble() {
  const services: Row[] = [];
  const categories: Row[] = [];
  const items: Row[] = [];
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const client = {
    service: {
      upsert: async ({ where, update, create }: any): Promise<Row> => {
        const found = services.find((row) => row.code === where.code);
        if (found) return Object.assign(found, update);
        const row: Row = { id: nextId('svc'), active: true, createdAt: new Date(seq), ...create };
        services.push(row);
        return row;
      },
      findMany: async ({ where, orderBy }: any) =>
        sortRows(services.filter((row) => matches(row, where ?? {})), orderBy),
      findUnique: async ({ where }: any) =>
        services.find((row) => row.id === where.id || row.code === where.code) ?? null,
    },
    catalogCategory: {
      upsert: async ({ where, update, create }: any): Promise<Row> => {
        const { serviceId, code } = where.serviceId_code;
        const found = categories.find((row) => row.serviceId === serviceId && row.code === code);
        if (found) return Object.assign(found, update);
        const row: Row = { id: nextId('cat'), active: true, ...create };
        categories.push(row);
        return row;
      },
      findMany: async ({ where, orderBy }: any) =>
        sortRows(categories.filter((row) => matches(row, where ?? {})), orderBy),
      findFirst: async ({ where }: any) => categories.find((row) => matches(row, where)) ?? null,
      findUnique: async ({ where }: any) => categories.find((row) => row.id === where.id) ?? null,
    },
    catalogItem: {
      upsert: async ({ where, update, create }: any): Promise<Row> => {
        const { categoryId, code } = where.categoryId_code;
        const found = items.find((row) => row.categoryId === categoryId && row.code === code);
        if (found) return Object.assign(found, update);
        const row: Row = { id: nextId('item'), active: true, ...create };
        items.push(row);
        return row;
      },
      findMany: async ({ where, orderBy }: any) =>
        sortRows(items.filter((row) => matches(row, where ?? {})), orderBy),
    },
  };

  return { client: client as never, stores: { services, categories, items } };
}

async function seeded() {
  const { client, stores } = createCatalogDouble();
  await seedCatalogV2(client as never);
  return { service: new CatalogV2Service(client), stores };
}

async function categoryIdOf(service: CatalogV2Service, code: string, category: string) {
  const categories = await service.listCategories(code);
  const found = categories.find((entry) => entry.code === category);
  if (!found) throw new Error(`Catégorie ${category} absente de ${code}`);
  return found.id;
}

describe('Catalogue v2 — lecture', () => {
  it('listServices renvoie les 3 prestations', async () => {
    const { service } = await seeded();
    const services = await service.listServices();
    expect(services).toHaveLength(3);
    expect(services.map((entry) => entry.code).sort()).toEqual(['FRP', 'SMARTPHONE', 'SYSTEME']);
  });

  it('un visiteur non-B2B lit le tarif public (Tecno = 3000)', async () => {
    const { service } = await seeded();
    const categoryId = await categoryIdOf(service, 'FRP', 'TECNO');
    const items = await service.listItems('FRP', categoryId, { forPro: false });
    const spark20 = items.find((entry) => entry.code === 'TECNO_SPARK_20');
    expect(spark20?.price).toBe(3000);
    expect(spark20?.surDevis).toBe(false);
  });

  it('un compte B2B lit le tarif professionnel (Tecno = 1500)', async () => {
    const { service } = await seeded();
    const categoryId = await categoryIdOf(service, 'FRP', 'TECNO');
    const items = await service.listItems('FRP', categoryId, { forPro: true });
    const spark20 = items.find((entry) => entry.code === 'TECNO_SPARK_20');
    expect(spark20?.price).toBe(1500);
    expect(spark20?.surDevis).toBe(false);
  });

  it('un tarif null devient { price: null, surDevis: true }', async () => {
    const { service } = await seeded();
    const categoryId = await categoryIdOf(service, 'SYSTEME', 'SOFTWARE');
    const items = await service.listItems('SYSTEME', categoryId, { forPro: false });
    expect(items).toHaveLength(1);
    expect(items[0].price).toBeNull();
    expect(items[0].surDevis).toBe(true);
  });
});

describe('Catalogue v2 — seed', () => {
  it('seede les volumes attendus (59 Tecno + 8 autres)', async () => {
    const { stores } = await seeded();
    expect(stores.services).toHaveLength(3);
    expect(stores.categories).toHaveLength(9);
    expect(stores.items).toHaveLength(SEED_TOTALS.items);
    expect(SEED_TOTALS.items).toBe(67);
    const frp = stores.categories.find((entry) => entry.code === 'TECNO');
    expect(stores.items.filter((entry) => entry.categoryId === frp?.id)).toHaveLength(59);
  });

  it('est idempotent : rejouer ne crée aucun doublon et ne change aucun id', async () => {
    const { client, stores } = createCatalogDouble();
    await seedCatalogV2(client as never);
    const before = {
      services: stores.services.length,
      categories: stores.categories.length,
      items: stores.items.length,
      spark20Id: stores.items.find((entry) => entry.code === 'TECNO_SPARK_20')?.id,
    };

    await seedCatalogV2(client as never);

    expect(stores.services).toHaveLength(before.services);
    expect(stores.categories).toHaveLength(before.categories);
    expect(stores.items).toHaveLength(before.items);
    expect(stores.items.find((entry) => entry.code === 'TECNO_SPARK_20')?.id).toBe(before.spark20Id);

    const keys = stores.items.map((entry) => `${entry.categoryId}/${entry.code}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
