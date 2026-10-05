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
  Matches,
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

export class CreateDemandeDto {
  @IsIn(ALLOWED_CATEGORIES)
  categoryId: string;

  /* Appareil (catalogue) — parcours client simplifié : catégorie
   * (domaine) + marque réelle et active obligatoires côté service quand un
   * domaine est fourni ; `modelId`/`problemId` restent acceptés pour
   * compatibilité (anciens clients, flux technicien) mais ne sont plus
   * demandés au client. Sans domaine (hors catalogue), `equipmentFamily`
   * (indice structuré) est exigé quand la catégorie vaut `autre`. */
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

  /* Description libre du problème, en langage naturel.
   *
   * OBLIGATOIRE (10 caractères minimum, 1000 maximum) : c'est la seule source
   * de contexte lisible par le dispatch et par le technicien. Le wizard
   * client l'exige déjà depuis l'étape « Votre panne » ; la règle est donc
   * portée ici pour que TOUT appelant la respecte, y compris un appel direct
   * à l'API qui contournerait l'interface.
   *
   * Rappel : un dossier sans descriptiontexte ne peut pas être classifié et
   * arrive vide au technicien.
   *
   * `@Matches(/\S/)` : `@IsNotEmpty` et `@MinLength` acceptent une chaîne
   * entièrement blanches («          » = 10 caractères). Sans ce garde-fou,
   * la règle serait contournable en une ligne et le problème d'origine
   * (demande inexploitable) resterait entier. */
  @IsString()
  @IsNotEmpty({ message: 'Décrivez votre problème en quelques mots.' })
  @MinLength(10, { message: 'La description doit contenir au moins 10 caractères.' })
  @MaxLength(1000, { message: 'La description ne peut pas dépasser 1000 caractères.' })
  @Matches(/\S/, { message: 'La description doit contenir au moins un caractère visible.' })
  description: string;

  /* Parcours « Autre appareil » — indice structuré (code de famille, ex.
   * GAME_CONSOLE, UNKNOWN) choisi dans la liste du catalogue. Exigé par le
   * service quand il n'y a pas de domaine et que la catégorie vaut `autre` ;
   * la famille doit exister et être active (jamais de valeur arbitraire).
   * Remplace le texte libre historique pour les nouvelles demandes. */
  @IsOptional()
  @IsString()
  @MaxLength(40)
  equipmentFamily?: string;

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