import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { projectPrice } from './catalog.service.js';
import type { CatalogItemView } from './catalog.types.js';
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
  travelFee: number | null;
  paymentType: string;
};

/**
 * M1 — administration des items du catalogue v2.
 *
 * La suppression est logique (`active = false`) : un item référencé par des
 * demandes doit rester lisible, il disparaît seulement des parcours.
 *
 * Invariant d'écriture : un item actif a un tarif public, et un tarif
 * professionnel quand sa prestation est ouverte aux professionnels. C'est la
 * condition qui rend la lecture publique fidèle — un item actif sans montant
 * serait proposé puis affiché sans prix. Quand les deux tarifs existent, le
 * tarif professionnel ne dépasse jamais la moitié du tarif public. Ces règles
 * sont contrôlées à la création, à l'activation et à chaque réglage de tarif,
 * sur l'état-resultat de l'écriture et pas seulement sur le champ demandé.
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

    const active = dto.active ?? true;
    const proAvailable = await this.serviceProAvailable(category.serviceId);
    assertItemPrices(active, dto.pricePublic ?? null, dto.pricePro ?? null, proAvailable);

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
        active,
        paymentType: dto.paymentType ?? 'END_OF_SERVICE',
      },
    });
    return toItemView(created);
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

    if (dto.active !== undefined) {
      const proAvailable = await this.categoryProAvailable(existing.categoryId);
      assertItemPrices(dto.active, existing.pricePublic, existing.pricePro, proAvailable);
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
        ...(dto.paymentType !== undefined ? { paymentType: dto.paymentType } : {}),
      },
    });
    return toItemView(updated);
  }

  /** Suppression logique : l'item reste en base, il quitte les parcours. */
  async deactivateItem(id: string): Promise<CatalogItemView> {
    await this.getItem(id);
    const updated = await this.prisma.catalogItem.update({
      where: { id },
      data: { active: false },
    });
    return toItemView(updated);
  }

  async updatePrices(
    id: string,
    dto: UpdateCatalogItemPricesDto,
  ): Promise<{ pricePublic: number | null; pricePro: number | null; travelFee: number | null }> {
    if (
      dto.pricePublic === undefined &&
      dto.pricePro === undefined &&
      dto.travelFee === undefined &&
      dto.active === undefined
    ) {
      throw new BadRequestException('Aucun tarif à mettre à jour.');
    }
    const existing = await this.getItem(id);

    const pricePublic = dto.pricePublic !== undefined ? dto.pricePublic : existing.pricePublic;
    const pricePro = dto.pricePro !== undefined ? dto.pricePro : existing.pricePro;
    const travelFee = dto.travelFee !== undefined ? dto.travelFee : existing.travelFee;
    const active = dto.active !== undefined ? dto.active : existing.active;
    const proAvailable = await this.categoryProAvailable(existing.categoryId);
    assertItemPrices(active, pricePublic, pricePro, proAvailable);

    const updated = await this.prisma.catalogItem.update({
      where: { id },
      data: {
        pricePublic,
        pricePro,
        travelFee,
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
    });
    return { pricePublic: updated.pricePublic, pricePro: updated.pricePro, travelFee: updated.travelFee };
  }

  /**
   * Ouverture / fermeture d'une prestation. L'ouverture exige au moins un item
   * actif : une prestation ouverte sans aucun item serait un parcours vide.
   */
  async setServiceActive(code: string, active: boolean): Promise<{ code: string; active: boolean }> {
    const service = await this.prisma.service.findUnique({ where: { code: code as never } });
    if (!service) throw new NotFoundException('Prestation introuvable.');

    if (active) {
      const categories = await this.prisma.catalogCategory.findMany({
        where: { serviceId: service.id },
        select: { id: true },
      });
      const activeItem = await this.prisma.catalogItem.findFirst({
        where: { categoryId: { in: categories.map((category) => category.id) }, active: true },
        select: { id: true },
      });
      if (!activeItem) {
        throw new BadRequestException(
          'Activez au moins un item avant d’ouvrir cette prestation.',
        );
      }
    }

    const updated = await this.prisma.service.update({
      where: { id: service.id },
      data: { active },
    });
    return { code: updated.code, active: updated.active };
  }

  private async getItem(id: string): Promise<ItemRow> {
    const item = await this.prisma.catalogItem.findUnique({ where: { id } });
    if (!item) throw new NotFoundException('Item introuvable.');
    return item;
  }

  private async categoryProAvailable(categoryId: string): Promise<boolean> {
    const category = await this.prisma.catalogCategory.findUnique({ where: { id: categoryId } });
    if (!category) throw new NotFoundException('Catégorie introuvable.');
    return this.serviceProAvailable(category.serviceId);
  }

  private async serviceProAvailable(serviceId: string): Promise<boolean> {
    const service = await this.prisma.service.findUnique({ where: { id: serviceId } });
    if (!service) throw new NotFoundException('Prestation introuvable.');
    return service.proAvailable;
  }
}

/**
 * Règles de tarif d'un item : actif = tarif public obligatoire, plus tarif
 * professionnel si la prestation est ouverte aux professionnels ; deux tarifs
 * présents = professionnel au plus à la moitié du public.
 */
function assertItemPrices(
  active: boolean,
  pricePublic: number | null,
  pricePro: number | null,
  proAvailable: boolean,
): void {
  if (active && pricePublic === null) {
    throw new BadRequestException('Un item actif doit avoir un prix public');
  }
  if (active && proAvailable && pricePro === null) {
    throw new BadRequestException('Un item actif doit avoir un prix pro');
  }
  if (pricePublic !== null && pricePro !== null && pricePro > pricePublic / 2) {
    throw new BadRequestException(
      'Le prix pro doit être inférieur ou égal à la moitié du prix public',
    );
  }
}

function toItemView(item: ItemRow): CatalogItemView {
  return {
    id: item.id,
    categoryId: item.categoryId,
    code: item.code,
    label: item.label,
    description: item.description,
    androidVersion: item.androidVersion,
    order: item.order,
    ...projectPrice(item),
    paymentType: item.paymentType,
  };
}
