import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ALLOWED_CATEGORIES } from '../categories.js';
import { REQUEST_TIMINGS } from './base-demande.dto.js';

/* Chantier D1 — mise à jour PARTIELLE d'un brouillon.
 *
 * DUPLICATION ASSUMÉE (et gardée honnête par un test) : le dépôt ne dépend pas
 * de `@nestjs/mapped-types` (interdit d'ajouter une dépendance ici), et il n'y
 * a pas de moyen de retirer les décorateurs `@IsNotEmpty()` / `@MinLength()`
 * hérités de `BaseDemandeDto` — en TS, un décorateur de propriété enfant
 * s'ADDITIONNE à celui du parent, il ne le remplace pas.
 *
 * Deux conséquences, et deux garde-fous :
 *  - chaque champ est re-déclaré avec `@IsOptional()` ;
 *  - les bornes (longueurs, min/max numériques) sont REPRISES À L'IDENTIQUE.
 *    Une validation plus laxiste à la mise à jour qu'à la création produirait
 *    un brouillon que `convert` refuse ensuite (400 sur une donnée que le
 *    client croyait avoir enregistrée).
 *  - les champs obligatoires de la base (`categoryId`, `description`, `city`)
 *    peuvent être MODIFIÉS mais pas supprimés : ils restent donc `IsNotEmpty`.
 *    Seule la longueur minimale de `description` (10) est propre à la
 *    création — l'update vérifie qu'il reste un caractère visible.
 *
 * `demande-draft.service.spec.ts` compare la liste des champs de ce DTO à celle
 * de `BaseDemandeDto` : ajouter un champ à la base sans l'ajouter ici fait
 * échouer le test. */
export class UpdateDemandeDraftDto {
  @IsOptional()
  @IsIn(ALLOWED_CATEGORIES)
  categoryId?: string;

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
  @MaxLength(1000, { message: 'La description ne peut pas dépasser 1000 caractères.' })
  @Matches(/\S/, { message: 'La description doit contenir au moins un caractère visible.' })
  description?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  equipmentFamily?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  city?: string;

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
  @IsIn(REQUEST_TIMINGS)
  requestedMode?: (typeof REQUEST_TIMINGS)[number];

  @IsOptional()
  @IsDateString()
  requestedAt?: string;
}