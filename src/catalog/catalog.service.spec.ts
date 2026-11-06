import { describe, expect, it } from 'vitest';
import { CatalogV2Service } from './catalog.service.js';
import { SEED_TOTALS, seedCatalogV2 } from '../../prisma/seed-catalog-data.js';
import { createCatalogDouble } from '../../test/catalog-double.js';

/* M1 — Catalogue v2 : ce que le visiteur voit, et ce que le seed écrit.
 *
 * Les fixtures ne sont pas recopiées à la main : le seed officiel est déroulé
 * sur le double en mémoire de `test/catalog-double.ts`, donc si le barème
 * change, ces assertions bougent avec lui. */

type Row = Record<string, any>;

async function seeded() {
  const { client, stores } = createCatalogDouble();
  await seedCatalogV2(client as never);
  return { service: new CatalogV2Service(client), stores };
}

function categoryRow(stores: { categories: Row[] }, code: string): Row {
  const found = stores.categories.find((entry) => entry.code === code);
  if (!found) throw new Error(`Catégorie ${code} absente du catalogue seedé`);
  return found;
}

describe('Catalogue v2 — visibilité', () => {
  it('un visiteur non-B2B lit le tarif public (Tecno = 3000)', async () => {
    const { service, stores } = await seeded();
    const tecno = categoryRow(stores, 'TECNO');
    const items = await service.listItems('FRP', tecno.id, undefined);
    const spark20 = items.find((entry) => entry.code === 'TECNO_SPARK_20');
    expect(spark20?.price).toBe(3000);
  });

  it('un compte B2B lit le tarif professionnel (Tecno = 1500)', async () => {
    const { service, stores } = await seeded();
    const tecno = categoryRow(stores, 'TECNO');
    const items = await service.listItems('FRP', tecno.id, 'B2B');
    const spark20 = items.find((entry) => entry.code === 'TECNO_SPARK_20');
    expect(spark20?.price).toBe(1500);
  });

  it('un item sans montant n’apparaît ni côté B2C ni côté B2B', async () => {
    const { service, stores } = await seeded();
    const screen = categoryRow(stores, 'SCREEN');
    expect(await service.listItems('SMARTPHONE', screen.id, undefined)).toEqual([]);
    expect(await service.listItems('SMARTPHONE', screen.id, 'B2B')).toEqual([]);
  });

  it('un item retiré mais tarifié reste invisible', async () => {
    const { service, stores } = await seeded();
    const drivers = categoryRow(stores, 'DRIVERS');
    const item = stores.items.find((entry) => entry.categoryId === drivers.id);
    item.active = false;

    expect(await service.listItems('SYSTEME', drivers.id, undefined)).toEqual([]);
  });

  it('un item actif sans tarif public est invisible côté B2C, tarifié côté B2B', async () => {
    const { service, stores } = await seeded();
    const drivers = categoryRow(stores, 'DRIVERS');
    const item = stores.items.find((entry) => entry.categoryId === drivers.id);
    item.pricePublic = null;

    expect(await service.listItems('SYSTEME', drivers.id, undefined)).toEqual([]);
    const proItems = await service.listItems('SYSTEME', drivers.id, 'B2B');
    expect(proItems.map((entry) => entry.price)).toEqual([1250]);
  });

  it('listServices ne renvoie pas SMARTPHONE tant que ses items sont retirés', async () => {
    const { service } = await seeded();
    const codes = (await service.listServices(undefined)).map((entry) => entry.code);
    expect(codes).toEqual(['SYSTEME', 'FRP']);
  });

  it('une catégorie sans item tarifié sort de listCategories', async () => {
    const { service } = await seeded();
    const categories = await service.listCategories('SYSTEME', undefined);
    expect(categories.map((entry) => entry.code)).toEqual(['REINSTALL_OS', 'DRIVERS']);
  });

  it('le retrait de tous les tarifs publics vide le parcours B2C sans toucher au B2B', async () => {
    const { service, stores } = await seeded();
    for (const item of stores.items) {
      if (item.pricePublic !== null) item.pricePublic = null;
    }
    expect(await service.listServices(undefined)).toEqual([]);
    expect((await service.listServices('B2B')).length).toBeGreaterThan(0);
  });

  it('une catégorie rattachée à une autre prestation ne rend rien', async () => {
    const { service, stores } = await seeded();
    const screen = categoryRow(stores, 'SCREEN');
    await expect(service.listItems('FRP', screen.id, undefined)).rejects.toThrow(
      'Catégorie introuvable.',
    );
  });
});

describe('Catalogue v2 — seed', () => {
  it('seede les volumes attendus (59 Tecno + 8 autres)', async () => {
    const { stores } = await seeded();
    expect(stores.services).toHaveLength(3);
    expect(stores.categories).toHaveLength(9);
    expect(stores.items).toHaveLength(SEED_TOTALS.items);
    expect(SEED_TOTALS.items).toBe(67);
    const frp = categoryRow(stores, 'TECNO');
    expect(stores.items.filter((entry) => entry.categoryId === frp.id)).toHaveLength(59);
  });

  it('déclare les tarifs et les activations du barème M1', async () => {
    const { stores } = await seeded();
    const byCode = new Map(stores.items.map((entry) => [entry.code, entry]));

    expect(byCode.get('REINSTALL_OS')).toMatchObject({
      pricePublic: 5000,
      pricePro: 2500,
      active: true,
    });
    expect(byCode.get('DRIVERS')).toMatchObject({
      pricePublic: 2500,
      pricePro: 1250,
      active: true,
    });
    for (const code of ['SOFTWARE', 'DEBRIDAGE', 'SCREEN', 'BATTERY', 'CONNECTOR', 'OTHER']) {
      expect(byCode.get(code)).toMatchObject({ pricePublic: null, pricePro: null, active: false });
    }

    const frpItems = stores.items.filter((entry) => entry.code.startsWith('TECNO_'));
    expect(frpItems).toHaveLength(59);
    for (const item of frpItems) {
      expect(item).toMatchObject({ pricePublic: 3000, pricePro: 1500, active: true });
      expect(item.androidVersion).toBeTruthy();
    }
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
    expect(stores.items.find((entry) => entry.code === 'TECNO_SPARK_20')?.id).toBe(
      before.spark20Id,
    );

    const keys = stores.items.map((entry) => `${entry.categoryId}/${entry.code}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('rétablit le barème du seed sur un item que l’administration avait modifié', async () => {
    const { client, stores } = createCatalogDouble();
    await seedCatalogV2(client as never);
    const reinstall = stores.items.find((entry) => entry.code === 'REINSTALL_OS');
    reinstall.pricePublic = 9999;
    reinstall.active = false;

    await seedCatalogV2(client as never);

    // Choix assumé : le seed est la source d'autorité des items qu'il déclare.
    expect(reinstall).toMatchObject({ pricePublic: 5000, pricePro: 2500, active: true });
  });
});
