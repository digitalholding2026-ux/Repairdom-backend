import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { projectPrice } from './catalog.service.js';
import type { CatalogItemView, CatalogPriceView } from './catalog.types.js';
import type {
  CreateCatalogItemDto,
  UpdateCatalogItemDto,
  UpdateCatalogItemPricesDto,
} from './dto/catalog-item.dto.js';

type ItemRow = {
  id: string;
  categoryId: string;
  code: string;
  label: string;
  description: string | null;
  androidVersion: string | null;
  active: boolean;
  order: number;
  pricePublic: number | null;
  pricePro: number | null;
};

/**
 * M1 — administration des items du catalogue v2.
 *
 * La suppression est logique (`active = false`) : un item référencé par des
 * demandes doit rester lisible, il disparaît seulement des parcours.
 * Le tarif rendu suit la même règle que la lecture publique, côté B2B.
 */
@Injectable()
export class CatalogAdminService {
  constructor(private readonly prisma: PrismaService) {}

  async createItem(dto: CreateCatalogItemDto): Promise<CatalogItemView> {
    const category = await this.prisma.catalogCategory.findUnique({
      where: { id: dto.categoryId },
    });
    if (!category) throw new NotFoundException('Catégorie introuvable.');

    const duplicate = await this.prisma.catalogItem.findFirst({
      where: { categoryId: dto.categoryId, code: dto.code },
    });
    if (duplicate) {
      throw new ConflictException('Un item porte déjà ce code dans cette catégorie.');
    }

    const created = await this.prisma.catalogItem.create({
      data: {
        categoryId: dto.categoryId,
        code: dto.code,
        label: dto.label,
        description: dto.description ?? null,
        androidVersion: dto.androidVersion ?? null,
        pricePublic: dto.pricePublic ?? null,
        pricePro: dto.pricePro ?? null,
        order: dto.order ?? 0,
        active: dto.active ?? true,
      },
    });
    return toItemView(created, { forPro: false });
  }

  async updateItem(id: string, dto: UpdateCatalogItemDto): Promise<CatalogItemView> {
    const existing = await this.getItem(id);

    if (dto.code && dto.code !== existing.code) {
      const duplicate = await this.prisma.catalogItem.findFirst({
        where: { categoryId: existing.categoryId, code: dto.code },
      });
      if (duplicate) {
        throw new ConflictException('Un item porte déjà ce code dans cette catégorie.');
      }
    }

    const updated = await this.prisma.catalogItem.update({
      where: { id },
      data: {
        ...(dto.code !== undefined ? { code: dto.code } : {}),
        ...(dto.label !== undefined ? { label: dto.label } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.androidVersion !== undefined ? { androidVersion: dto.androidVersion } : {}),
        ...(dto.order !== undefined ? { order: dto.order } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
    return toItemView(updated, { forPro: false });
  }

  /** Suppression logique : l'item reste en base, il quitte les parcours. */
  async deactivateItem(id: string): Promise<CatalogItemView> {
    await this.getItem(id);
    const updated = await this.prisma.catalogItem.update({
      where: { id },
      data: { active: false },
    });
    return toItemView(updated, { forPro: false });
  }

  async updatePrices(
    id: string,
    dto: UpdateCatalogItemPricesDto,
  ): Promise<{ pricePublic: number | null; pricePro: number | null }> {
    if (dto.pricePublic === undefined && dto.pricePro === undefined) {
      throw new BadRequestException('Aucun tarif à mettre à jour.');
    }
    await this.getItem(id);
    const updated = await this.prisma.catalogItem.update({
      where: { id },
      data: {
        ...(dto.pricePublic !== undefined ? { pricePublic: dto.pricePublic } : {}),
        ...(dto.pricePro !== undefined ? { pricePro: dto.pricePro } : {}),
      },
    });
    return { pricePublic: updated.pricePublic, pricePro: updated.pricePro };
  }

  private async getItem(id: string): Promise<ItemRow> {
    const item = await this.prisma.catalogItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Item introuvable.');
    return item;
  }
}

function toItemView(item: ItemRow, options: { forPro: boolean }): CatalogItemView {
  return {
    id: item.id,
    categoryId: item.categoryId,
    code: item.code,
    label: item.label,
    description: item.description,
    androidVersion: item.androidVersion,
    order: item.order,
    ...toPriceView(item, options),
  };
}

function toPriceView(
  item: { pricePublic: number | null; pricePro: number | null },
  options: { forPro: boolean },
): CatalogPriceView {
  return projectPrice(item, options.forPro);
}
