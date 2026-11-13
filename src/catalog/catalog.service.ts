import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CatalogCategoryView, CatalogItemView, CatalogServiceView } from './catalog.types.js';

/**
 * M1 — lecture du catalogue Relio v2 (prestations, catégories, items).
 *
 * Le tarif appliqué n'est jamais choisi par le client : les trois lectures
 * reçoivent la `clientType` de la session, déduite du JWT par le contrôleur.
 * Un compte B2B lit `pricePro`, tout autre visiteur lit `pricePublic`.
 *
 * Une prestation n'est visible que si elle a un prix dans la monnaie du
 * visiteur : un item sans tarif, un item retiré, une catégorie sans aucun item
 * tarifé et une prestation sans aucune catégorie tarifée sortent du parcours.
 * Une prestation fermée aux professionnels sort en plus du parcours B2B.
 * Rien n'est donc affiché « sur devis » — l'administration publie un montant ou
 * l'item reste hors circuit.
 */
@Injectable()
export class CatalogV2Service {
  constructor(private readonly prisma: PrismaService) {}

  /** Les prestations ouvertes à ce visiteur et qui ont au moins un tarif pour lui. */
  async listServices(clientType?: string): Promise<CatalogServiceView[]> {
    const services = await this.prisma.service.findMany({
      where: clientType === 'B2B' ? { active: true, proAvailable: true } : { active: true },
      orderBy: { createdAt: 'asc' },
    });
    if (services.length === 0) return [];

    const categories = await this.prisma.catalogCategory.findMany({
      where: { serviceId: { in: services.map((service) => service.id) }, active: true },
      select: { id: true, serviceId: true },
    });
    const pricedCategories = await this.pricedCategoryIds(categories.map((c) => c.id), clientType);
    const servicesWithPrices = new Set(
      categories
        .filter((category) => pricedCategories.has(category.id))
        .map((category) => category.serviceId),
    );

    return services
      .filter((service) => servicesWithPrices.has(service.id))
      .map((service) => ({
        id: service.id,
        code: service.code,
        label: service.label,
        description: service.description,
      }));
  }

  /** Les catégories tarifées d'une prestation, par `order` croissant. */
  async listCategories(serviceCode: string, clientType?: string): Promise<CatalogCategoryView[]> {
    const service = await this.readService(serviceCode);
    if (clientType === 'B2B' && !service.proAvailable) {
      throw new ForbiddenException('Cette prestation est réservée aux clients particuliers.');
    }
    const categories = await this.prisma.catalogCategory.findMany({
      where: { serviceId: service.id, active: true },
      orderBy: { order: 'asc' },
    });
    if (categories.length === 0) return [];

    const priced = await this.pricedCategoryIds(categories.map((c) => c.id), clientType);
    return categories
      .filter((category) => priced.has(category.id))
      .map((category) => ({
        id: category.id,
        serviceId: category.serviceId,
        code: category.code,
        label: category.label,
        order: category.order,
      }));
  }

  /**
   * Les items tarifés d'une catégorie, dans la monnaie du visiteur.
   * `categoryId` est vérifié rattaché à `serviceCode` : une URL croquant une
   * catégorie d'une autre prestation ne rend rien.
   * Quand `targetDevice` est fourni (MAC/PC/ALL), seuls les items dont la
   * cible correspond (ou ALL) sont retournés — utilisé pour filtrer les OS
   * selon le type de machine choisi (parcours Système).
   */
  async listItems(
    serviceCode: string,
    categoryId: string,
    clientType?: string,
    targetDevice?: string,
  ): Promise<CatalogItemView[]> {
    const service = await this.readService(serviceCode);
    const category = await this.prisma.catalogCategory.findFirst({
      where: { id: categoryId, serviceId: service.id, active: true },
    });
    if (!category) {
      throw new NotFoundException('Catégorie introuvable.');
    }

    const where: Record<string, unknown> = {
      categoryId: category.id,
      active: true,
      [priceColumn(clientType)]: { not: null },
    };
    if (targetDevice && targetDevice !== 'ALL') {
      where.targetDevice = targetDevice as never;
    }

    const items = await this.prisma.catalogItem.findMany({
      where,
      orderBy: { order: 'asc' },
    });

    return items.map((item) => ({
      id: item.id,
      categoryId: item.categoryId,
      code: item.code,
      label: item.label,
      description: item.description,
      androidVersion: item.androidVersion,
      order: item.order,
      price: projectPrice(item, clientType).price,
      paymentType: item.paymentType,
      targetDevice: item.targetDevice,
    }));
  }

  /** Colonnes `categoryId` des catégories ayant au moins un item tarifié. */
  private async pricedCategoryIds(
    categoryIds: string[],
    clientType?: string,
  ): Promise<Set<string>> {
    if (categoryIds.length === 0) return new Set();
    const items = await this.prisma.catalogItem.findMany({
      where: {
        categoryId: { in: categoryIds },
        active: true,
        [priceColumn(clientType)]: { not: null },
      },
      select: { categoryId: true },
    });
    return new Set(items.map((item) => item.categoryId));
  }

  private async readService(serviceCode: string) {
    const service = await this.prisma.service.findUnique({
      where: { code: serviceCode as never },
    });
    if (!service || !service.active) {
      throw new NotFoundException('Prestation introuvable.');
    }
    return service;
  }
}

/** La colonne de tarif lue par ce visiteur : professionnel uniquement pour un compte B2B. */
export function priceColumn(clientType?: string): 'pricePro' | 'pricePublic' {
  return clientType === 'B2B' ? 'pricePro' : 'pricePublic';
}

/** Le tarif retenu pour ce visiteur. */
export function projectPrice(
  prices: { pricePublic: number | null; pricePro: number | null },
  clientType?: string,
): { price: number | null } {
  return { price: prices[priceColumn(clientType)] };
}
