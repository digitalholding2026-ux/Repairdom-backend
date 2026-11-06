import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  CatalogCategoryView,
  CatalogItemView,
  CatalogPriceView,
  CatalogServiceView,
} from './catalog.types.js';

/**
 * M1 — lecture du catalogue Relio v2 (prestations, catégories, items).
 *
 * Le tarif appliqué n'est jamais choisi par le client : `listItems` reçoit un
 * booléen `forPro` que le contrôleur déduit de la session. Un compte B2B lit
 * `pricePro`, tout autre visiteur lit `pricePublic`.
 */
@Injectable()
export class CatalogV2Service {
  constructor(private readonly prisma: PrismaService) {}

  /** Les prestations proposées, dans l'ordre d'insertion. */
  async listServices(): Promise<CatalogServiceView[]> {
    const services = await this.prisma.service.findMany({
      where: { active: true },
      orderBy: { createdAt: 'asc' },
    });
    return services.map((service) => ({
      id: service.id,
      code: service.code,
      label: service.label,
      description: service.description,
    }));
  }

  /** Les catégories d'une prestation, par `order` croissant. */
  async listCategories(serviceCode: string): Promise<CatalogCategoryView[]> {
    const service = await this.prisma.service.findUnique({ where: { code: serviceCode as never } });
    if (!service || !service.active) {
      throw new NotFoundException('Prestation introuvable.');
    }
    const categories = await this.prisma.catalogCategory.findMany({
      where: { serviceId: service.id, active: true },
      orderBy: { order: 'asc' },
    });
    return categories.map((category) => ({
      id: category.id,
      serviceId: category.serviceId,
      code: category.code,
      label: category.label,
      order: category.order,
    }));
  }

  /**
   * Les items d'une catégorie, tarifés selon la nature du visiteur.
   * `categoryId` est vérifié rattaché à `serviceCode` : une URL croquant une
   * catégorie d'une autre prestation ne rend rien.
   */
  async listItems(
    serviceCode: string,
    categoryId: string,
    options: { forPro: boolean },
  ): Promise<CatalogItemView[]> {
    const service = await this.prisma.service.findUnique({ where: { code: serviceCode as never } });
    if (!service || !service.active) {
      throw new NotFoundException('Prestation introuvable.');
    }
    const category = await this.prisma.catalogCategory.findFirst({
      where: { id: categoryId, serviceId: service.id },
    });
    if (!category || !category.active) {
      throw new NotFoundException('Catégorie introuvable.');
    }
    const items = await this.prisma.catalogItem.findMany({
      where: { categoryId: category.id, active: true },
      orderBy: { order: 'asc' },
    });
    return items.map((item) => {
      const price = projectPrice(
        { pricePublic: item.pricePublic, pricePro: item.pricePro },
        options.forPro,
      );
      return {
        id: item.id,
        categoryId: item.categoryId,
        code: item.code,
        label: item.label,
        description: item.description,
        androidVersion: item.androidVersion,
        order: item.order,
        ...price,
      };
    });
  }
}

/** Le tarif retenu, et le drapeau « sur devis » quand il n'existe pas. */
export function projectPrice(
  prices: { pricePublic: number | null; pricePro: number | null },
  forPro: boolean,
): CatalogPriceView {
  const price = forPro ? prices.pricePro : prices.pricePublic;
  return { price, surDevis: price === null };
}
