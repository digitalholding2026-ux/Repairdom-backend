import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { ALLOWED_CATEGORIES } from '../categories.js';

export const REQUEST_TIMINGS = ['ASAP', 'SCHEDULED'] as const;

export const MEDIA_KINDS = ['IMAGE', 'VIDEO', 'AUDIO'] as const;
export const MAX_MEDIA_FILES = 5;
export const MAX_MEDIA_SIZE_BYTES = 25 * 1024 * 1024;

export class RequestMediaDto {
  @IsIn(MEDIA_KINDS)
  kind: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  mimeType: string;

  @IsInt()
  @Min(1)
  @Max(MAX_MEDIA_SIZE_BYTES)
  sizeBytes: number;
}

export class CreateDemandeDto {
  @IsIn(ALLOWED_CATEGORIES)
  categoryId: string;

  /* Appareil (catalogue) — Sprint 8.1. Tout est optionnel pour la
   * rétro-compatibilité : une demande « classique » sans appareil reste valide. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  domainId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  brandId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  modelId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  problemId?: string;

  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  description: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  city: string;

  /* Zone structurée (Sprint 8.8.2, règle E) — optionnelle pour rester
   * compatible avec les demandes historiques. Si fournie, la ville
   * structurée de la demande doit appartenir à la même ville que la zone. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  zoneId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  neighborhood?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  landmark?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;

  /* GPS V1 — position de la demande, strictement optionnelle (anciennes
   * demandes sans GPS inchangées). Bornes validées ici ; le texte
   * (ville/adresse) reste obligatoire et n'est jamais déduit du GPS.
   * (Pas de @Type() : la transformation d'un champ absent produirait NaN.) */
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_FILES)
  @ValidateNested({ each: true })
  @Type(() => RequestMediaDto)
  medias?: RequestMediaDto[];

  @IsOptional()
  @IsIn(REQUEST_TIMINGS)
  requestedMode?: (typeof REQUEST_TIMINGS)[number];

  @IsOptional()
  @IsDateString()
  requestedAt?: string;
}