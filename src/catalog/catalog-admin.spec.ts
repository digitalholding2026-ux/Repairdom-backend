import { ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CatalogAdminController } from './catalog-admin.controller.js';
import { CatalogAdminService } from './catalog-admin.service.js';
import { seedCatalogV2 } from '../../prisma/seed-catalog-data.js';
import { createCatalogDouble } from '../../test/catalog-double.js';

/* M1 — règles d'écriture du catalogue v2 : un item actif a un tarif public,
 * et un tarif professionnel quand sa prestation est ouverte aux professionnels.
 * Quand les deux tarifs existent, le professionnel ne dépasse pas la moitié du
 * public.
 *
 * La lecture publique ne sert que des items dont le montant du visiteur est
 * renseigné ; l'invariant inverse — actif sans montant — créerait une
 * prestation annoncée puis affichée sans prix. Le contrôle est donc testé sur
 * les trois écritures qui peuvent le violer (création, activation, tarif), et
 * au deux niveaux : le service, et la route HTTP avec le pipe de validation de
 * `main.ts`, pour que le refus sorte en 400 avec son message et pas en 500.
 *
 * AUCUNE INFRASTRUCTURE : le double en mémoire de `test/catalog-double.ts`
 * reçoit réellement les écritures, et les fixtures viennent du seed. */

const PUBLIC_MESSAGE = 'Un item actif doit avoir un prix public';
const PRO_MESSAGE = 'Un item actif doit avoir un prix pro';
const HALF_MESSAGE = 'Le prix pro doit être inférieur ou égal à la moitié du prix public';

const { client, stores } = createCatalogDouble();
let service: CatalogAdminService;
let app: INestApplication;

function itemOf(categoryCode: string) {
  const category = stores.categories.find((entry) => entry.code === categoryCode);
  const item = stores.items.find((entry) => entry.categoryId === category?.id);
  if (!item) throw new Error(`Item de la catégorie ${categoryCode} absent du double`);
  return item;
}

beforeAll(async () => {
  await seedCatalogV2(client as never);
  service = new CatalogAdminService(client as unknown as PrismaService);

  const moduleRef = await Test.createTestingModule({
    controllers: [CatalogAdminController],
    providers: [
      { provide: PrismaService, useValue: client },
      { provide: CatalogAdminService, useValue: service },
    ],
  })
    .overrideGuard(JwtAuthGuard)
    .useValue({ canActivate: () => true })
    .overrideGuard(RolesGuard)
    .useValue({ canActivate: () => true })
    .compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  await app.init();
});

describe('Catalogue v2 admin — création', () => {
  it('refuse un item actif dont le tarif public manque', async () => {
    const category = stores.categories.find((entry) => entry.code === 'SOFTWARE');
    await expect(
      service.createItem({
        categoryId: category.id,
        code: 'WORD',
        label: 'Installation Word',
        pricePro: 1000,
      } as never),
    ).rejects.toThrow(PUBLIC_MESSAGE);
    expect(stores.items.some((entry) => entry.code === 'WORD')).toBe(false);
  });

  it('refuse un item actif dont le tarif professionnel manque (prestation ouverte aux pros)', async () => {
    const category = stores.categories.find((entry) => entry.code === 'SOFTWARE');
    await expect(
      service.createItem({
        categoryId: category.id,
        code: 'EXCEL',
        label: 'Installation Excel',
        pricePublic: 1000,
      } as never),
    ).rejects.toThrow(PRO_MESSAGE);
  });

  it('accepte un item actif sans tarif pro sur une prestation réservée aux particuliers', async () => {
    const category = stores.categories.find((entry) => entry.code === 'OTHER');
    const created = await service.createItem({
      categoryId: category.id,
      code: 'VITRE',
      label: 'Vitre arrière',
      pricePublic: 4000,
    } as never);
    expect(created).toMatchObject({ price: 4000 });
    expect(stores.items.find((entry) => entry.code === 'VITRE')).toMatchObject({
      pricePro: null,
      active: true,
    });
  });

  it('refuse un tarif professionnel supérieur à la moitié du tarif public', async () => {
    const category = stores.categories.find((entry) => entry.code === 'SOFTWARE');
    await expect(
      service.createItem({
        categoryId: category.id,
        code: 'OFFICE',
        label: 'Installation Office',
        pricePublic: 4000,
        pricePro: 2001,
      } as never),
    ).rejects.toThrow(HALF_MESSAGE);
    expect(stores.items.some((entry) => entry.code === 'OFFICE')).toBe(false);
  });

  it('accepte un item retiré sans aucun tarif', async () => {
    const category = stores.categories.find((entry) => entry.code === 'SOFTWARE');
    const created = await service.createItem({
      categoryId: category.id,
      code: 'LEGACY',
      label: 'Ancienne prestation',
      active: false,
    } as never);
    expect(created.price).toBeNull();
    expect(stores.items.find((entry) => entry.code === 'LEGACY')).toMatchObject({ active: false });
  });

  it('accepte un item actif avec ses deux tarifs', async () => {
    const category = stores.categories.find((entry) => entry.code === 'SOFTWARE');
    const created = await service.createItem({
      categoryId: category.id,
      code: 'ANTIVIRUS',
      label: 'Installation antivirus',
      pricePublic: 4000,
      pricePro: 2000,
    } as never);
    expect(created).toMatchObject({ price: 4000 });
  });
});

describe('Catalogue v2 admin — activation', () => {
  it('refuse d’activer un item sans tarif', async () => {
    const software = itemOf('SOFTWARE');
    expect(software.active).toBe(false);
    await expect(service.updateItem(software.id, { active: true })).rejects.toThrow(PUBLIC_MESSAGE);
    expect(software.active).toBe(false);
  });

  it('refuse d’activer par le tarif si les deux montants ne suivent pas', async () => {
    const software = itemOf('SOFTWARE');
    await expect(
      service.updatePrices(software.id, { pricePublic: 3000, active: true }),
    ).rejects.toThrow(PRO_MESSAGE);
    expect(software).toMatchObject({ pricePublic: null, active: false });
  });

  it('active quand les deux tarifs sont posés en même temps', async () => {
    const software = itemOf('SOFTWARE');
    const prices = await service.updatePrices(software.id, {
      pricePublic: 3000,
      pricePro: 1500,
      active: true,
    });
    expect(prices).toEqual({ pricePublic: 3000, pricePro: 1500 });
    expect(software).toMatchObject({ active: true, pricePublic: 3000, pricePro: 1500 });
  });

  it('refuse de retirer un tarif à un item actif', async () => {
    await expect(
      service.updatePrices(itemOf('DRIVERS').id, { pricePublic: null }),
    ).rejects.toThrow(PUBLIC_MESSAGE);
  });

  it('refuse un réglage de tarif pro au-dessus de la moitié du public', async () => {
    const drivers = itemOf('DRIVERS');
    await expect(
      service.updatePrices(drivers.id, { pricePro: 1251 }),
    ).rejects.toThrow(HALF_MESSAGE);
    expect(drivers.pricePro).toBe(1250);
  });

  it('laisse retirer un item actif sans rien tarifier', async () => {
    const drivers = itemOf('DRIVERS');
    const view = await service.deactivateItem(drivers.id);
    expect(drivers.active).toBe(false);
    expect(view.price).toBe(2500);
  });

  it('autorise les deux tarifs d’un item retiré', async () => {
    const drivers = itemOf('DRIVERS');
    await service.deactivateItem(drivers.id);

    const prices = await service.updatePrices(drivers.id, {
      pricePublic: 2500,
      pricePro: 1250,
    });
    expect(prices).toEqual({ pricePublic: 2500, pricePro: 1250 });
    expect(drivers.active).toBe(false);
  });
});

describe('Catalogue v2 admin — route HTTP', () => {
  it('PATCH prix : 400 et message lisible quand active=true sans tarif public', async () => {
    const other = itemOf('OTHER');
    const response = await request(app.getHttpServer())
      .patch(`/admin/catalog/items/${other.id}/prices`)
      .send({ active: true });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe(PUBLIC_MESSAGE);
    expect(other).toMatchObject({ pricePublic: null, active: false });
  });

  it('PATCH prix : 200 quand active=true s’accompagne des deux montants', async () => {
    const screen = itemOf('SCREEN');
    const response = await request(app.getHttpServer())
      .patch(`/admin/catalog/items/${screen.id}/prices`)
      .send({ pricePublic: 5000, pricePro: 2500, active: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ pricePublic: 5000, pricePro: 2500 });
    expect(screen.active).toBe(true);
  });

  it('PATCH item : 400 à l’activation d’un item non tarifié', async () => {
    const other = itemOf('OTHER');
    const response = await request(app.getHttpServer())
      .patch(`/admin/catalog/items/${other.id}`)
      .send({ active: true });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe(PUBLIC_MESSAGE);
  });

  it('POST item : 400 à la création d’un item actif sans tarif', async () => {
    const category = stores.categories.find((entry) => entry.code === 'OTHER');
    const response = await request(app.getHttpServer())
      .post('/admin/catalog/items')
      .send({ categoryId: category.id, code: 'NO_PRICE', label: 'Sans tarif' });

    expect(response.status).toBe(400);
    expect(response.body.message).toBe(PUBLIC_MESSAGE);
  });
});

describe('Catalogue v2 admin — ouverture d’une prestation', () => {
  it('refuse d’ouvrir une prestation sans aucun item actif', async () => {
    const smartphone = stores.services.find((entry) => entry.code === 'SMARTPHONE');
    const categories = stores.categories.filter((entry) => entry.serviceId === smartphone.id);
    const items = stores.items.filter((entry) =>
      categories.some((category) => category.id === entry.categoryId),
    );
    for (const item of items) item.active = false;

    await expect(service.setServiceActive('SMARTPHONE', true)).rejects.toThrow(
      'Activez au moins un item avant d’ouvrir cette prestation.',
    );
    expect(smartphone.active).toBe(true);

    items[0].active = true;
    const response = await request(app.getHttpServer())
      .patch('/admin/catalog/services/SMARTPHONE')
      .send({ active: true });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ code: 'SMARTPHONE', active: true });
  });

  it('ferme puis rouvre une prestation qui a un item actif', async () => {
    const closed = await service.setServiceActive('FRP', false);
    expect(closed).toMatchObject({ code: 'FRP', active: false });
    const reopened = await service.setServiceActive('FRP', true);
    expect(reopened).toMatchObject({ code: 'FRP', active: true });
  });
});
