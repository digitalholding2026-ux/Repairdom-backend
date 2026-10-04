import { IsBoolean, IsIn, IsInt, IsOptional, IsString, MaxLength, Min, ValidateIf } from 'class-validator';
import { ALLOWED_CATEGORIES } from '../../demandes/categories.js';

/* ── EquipmentFamily (parcours « Autre appareil ») ────────────── */

export class CreateFamilyDto {
  @IsString()
  @MaxLength(40)
  code: string;

  @IsString()
  @MaxLength(100)
  label: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  icon?: string;

  @IsString()
  @IsIn(ALLOWED_CATEGORIES)
  category: string;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class UpdateFamilyDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  icon?: string;

  @IsOptional()
  @IsString()
  @IsIn(ALLOWED_CATEGORIES)
  category?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

/* ── ServiceDomain ────────────────────────────────────────────── */

export class CreateDomainDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsString()
  @MaxLength(100)
  slug: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;
}

export class UpdateDomainDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  icon?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

/* ── DeviceBrand / DeviceModel ────────────────────────────────── */

export class CreateBrandDto {
  @IsString()
  domainId: string;

  @IsString()
  @MaxLength(150)
  name: string;

  @IsString()
  @MaxLength(150)
  slug: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class UpdateBrandDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

export class CreateModelDto {
  @IsString()
  brandId: string;

  @IsString()
  @MaxLength(150)
  name: string;

  @IsString()
  @MaxLength(150)
  slug: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class UpdateModelDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

/* ── Problem ──────────────────────────────────────────────────── */

export class CreateProblemDto {
  @IsString()
  domainId: string;

  @IsOptional()
  @IsString()
  brandId?: string;

  @IsOptional()
  @IsString()
  modelId?: string;

  @IsString()
  @MaxLength(150)
  name: string;

  @IsString()
  @MaxLength(150)
  slug: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}

export class UpdateProblemDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  brandId?: string;

  @IsOptional()
  @IsString()
  modelId?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

/* ── CatalogDiagnostic ────────────────────────────────────────── */

/* Catalogue simplifié : l'Admin ne saisit plus que nom/slug/description.
 * Les champs techniques ci-dessous restent ACCEPTÉS (compatibilité fiche
 * catalogue lue par le technicien) mais ne sont plus proposés dans
 * l'interface Admin. Ne pas les supprimer du schéma sans audit des flux
 * collaboration/technicien. */
export class CreateDiagnosticDto {
  @IsString()
  problemId: string;

  @IsString()
  @MaxLength(150)
  name: string;

  @IsString()
  @MaxLength(150)
  slug: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  confidence?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  difficulty?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  estimatedTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  internalNotes?: string;
}

export class UpdateDiagnosticDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  confidence?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  difficulty?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  estimatedTime?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  internalNotes?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

/* ── CatalogIntervention ──────────────────────────────────────── */

/* Catalogue simplifié : l'Admin ne saisit plus que nom/slug/description.
 * difficulty / estimatedTime / needsParts / partsNote restent ACCEPTÉS
 * (affichage technicien via collaboration.service) mais masqués de
 * l'interface Admin. */
export class CreateInterventionDto {
  @IsString()
  diagnosticId: string;

  @IsString()
  @MaxLength(150)
  name: string;

  @IsString()
  @MaxLength(150)
  slug: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  difficulty?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  estimatedTime?: string;

  @IsOptional()
  @IsBoolean()
  needsParts?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  partsNote?: string;
}

export class UpdateInterventionDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  slug?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  difficulty?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  estimatedTime?: string;

  @IsOptional()
  @IsBoolean()
  needsParts?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  partsNote?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  sortOrder?: number;
}

/* ── Pricing ──────────────────────────────────────────────────── */

/* Catalogue simplifié : l'Admin ne saisit que minPrice / referencePrice /
 * maxPrice (validés par CatalogService.assertPricingValid, seule autorité).
 * travelFee / serviceFee / currency / priceMode restent ACCEPTÉS
 * (snapshots Quote.initialTravelFee/initialServiceFee) mais masqués de
 * l'interface Admin. */
export class CreatePricingDto {
  @IsString()
  interventionId: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  minPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  referencePrice?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  maxPrice?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  travelFee?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  serviceFee?: number;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  priceMode?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePricingDto {
  // Les champs tarifaires acceptent `null` pour « effacer » une borne ou un
  // frais (ex. bascule d'une fourchette vers une cotation fixe). La valence
  // finale (non-négatifs, min <= reference <= max) est garantie par
  // CatalogService.assertPricingValid sur la valeur fusionnée.
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  minPrice?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  referencePrice?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  maxPrice?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  travelFee?: number | null;

  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  serviceFee?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  priceMode?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/* ── ServiceCity (villes / zones de service) ──────────────────── */

export class CreateCityDto {
  @IsString()
  @MaxLength(100)
  name: string;

  @IsString()
  @MaxLength(100)
  slug: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateCityDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/* ── Zone (quartiers/secteurs d'une ServiceCity) ────────────────── */

export class CreateZoneDto {
  @IsString()
  cityId: string;

  @IsString()
  @MaxLength(150)
  name: string;

  @IsString()
  @MaxLength(150)
  slug: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

export class UpdateZoneDto {
  @IsOptional()
  @IsString()
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(150)
  slug?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
