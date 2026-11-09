import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/* M1 — items du catalogue v2, côté administration. */

export class CreateCatalogItemDto {
  @IsString()
  categoryId: string;

  @IsString()
  @MaxLength(60)
  code: string;

  @IsString()
  @MaxLength(120)
  label: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  androidVersion?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  pricePublic?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  pricePro?: number | null;

  @IsOptional()
  @IsInt()
  order?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateCatalogItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(60)
  code?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  androidVersion?: string | null;

  @IsOptional()
  @IsInt()
  order?: number;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

/**
 * Les deux tarifs se règlent ensemble. `active` est accepté ici pour que
 * l'activation et la tarification se fassent en une écriture : activer sans
 * les deux montants est refusé, voir `CatalogAdminService.updatePrices`.
 */
export class UpdateCatalogItemPricesDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  pricePublic?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  pricePro?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  travelFee?: number | null;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
