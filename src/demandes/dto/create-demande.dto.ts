import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { BaseDemandeDto, REQUEST_TIMINGS } from './base-demande.dto.js';

/* `REQUEST_TIMINGS` vit désormais dans `base-demande.dto.ts` (pour casser le
 * cycle d'import) ; il est ré-exporté ici car tout le dépôt l'importe depuis
 * ce fichier. */
export { REQUEST_TIMINGS };

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

  /* Dépôt multimédia — chemin d'objet retourné par
   * `POST /demandes/medias/upload` (upload réel AVANT création).
   * Optionnel pour compatibilité (métadonnées historiques) ; les nouveaux
   * médias uploadés le renseignent toujours (accès immédiat garanti). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  storagePath?: string;
}

/* Chantier D1 — `CreateDemandeDto` hérite désormais de `BaseDemandeDto`.
 *
 * Les champs partagés (catégorie, appareil, description, ville, GPS, moment
 * souhaité) et LEURS validateurs vivent dans `./base-demande.dto.ts`, partagés
 * avec le brouillon non authentifié `CreateDemandeDraftDto`. Le comportement
 * validé par la ValidationPipe globale est strictement inchangé : les
 * décorateurs sont hérités.
 *
 * Ne restent ici que les champs propres à la demande AUTHENTIFIÉE. */
export class CreateDemandeDto extends BaseDemandeDto {
  /* `modelId` / `problemId` : acceptés pour compatibilité (anciens clients,
   * flux technicien) mais jamais produits par le wizard client. */
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

  /* Zone structurée (Sprint 8.8.2, règle E) — optionnelle pour rester
   * compatible avec les demandes historiques. Si fournie, la ville
   * structurée de la demande doit appartenir à la même ville que la zone. */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  zoneId?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_FILES)
  @ValidateNested({ each: true })
  @Type(() => RequestMediaDto)
  medias?: RequestMediaDto[];

  /* Redéclaré pour la lisibilité du contrat public de `POST /demandes` :
   * la classe parente porte déjà `@IsOptional() @IsIn(REQUEST_TIMINGS)`.
   * Redondance volontaire, aucun effet sur la validation. */
  @IsOptional()
  @IsIn(REQUEST_TIMINGS)
  declare requestedMode?: (typeof REQUEST_TIMINGS)[number];

  /* Idem : `@IsOptional() @IsDateString()` hérité de la base. */
  @IsOptional()
  @IsDateString()
  declare requestedAt?: string;
}