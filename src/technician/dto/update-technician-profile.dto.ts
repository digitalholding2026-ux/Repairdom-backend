import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ALLOWED_CATEGORIES } from '../../demandes/categories.js';
import {
  IDENTITY_DOCUMENT_TYPES,
  NATIONALITY_ALPHA2_LENGTH,
} from '../identity-documents.js';
import { NATIONALITIES } from '../nationalities.js';

/**
 * Forme tableau exigée par `@IsIn` de class-validator. La source reste
 * `nationalities.ts` : ce tableau n'est qu'un adaptateur, jamais une seconde
 * liste. La validation service (`normalizeNationalityInput`) repose sur le
 * `Set`, donc les deux portes sont alimentées par la même nomenclature.
 */
const NATIONALITY_CODE_LIST = NATIONALITIES.map((entry) => entry.code);

const MAX_SPECIALTIES = 20;
const MAX_FAMILY_CODES = 60;
/** Valeurs de l'enum Prisma `TechnicianActivityType` (source de vérité du schéma). */
const ACTIVITY_TYPES = ['FREELANCE', 'SALARIED', 'COMPANY', 'OTHER'] as const;
/**
 * Bio = présentation courte destinée au profil professionnel (client ET
 * technicien). 600 caractères : assez pour un paragraphe, trop court pour
 * devenir un CV. Le champ texte `experience` (2000) reste le récit libre.
 */
const MAX_BIO_LENGTH = 600;
/** Plage cohérente avec la contrainte SQL `TechnicianProfile_experienceYears_range`. */
const MIN_EXPERIENCE_YEARS = 0;
const MAX_EXPERIENCE_YEARS = 70;

export class UpdateTechnicianProfileDto {
  /* ── Chantier #5B — ville de référence ────────────────────────────────
   *
   * `cityId` est le nouveau chemin STRUCTURÉ : c'est lui qui débloque la
   * gestion des zones (/technicien/zones n'offre plus de renvoyer vers le
   * profil) et qui permet de filtrer les missions par ville.
   *
   * `city` (texte) reste accepté pour les appelants historiques, mais il ne
   * peut PLUS-alone résoudre : sans matching fiable il produisait des
   * comptes sans rattachement. Si les deux sont fournis, `cityId` l'emporte :
   * c'est la donnée de référence, le texte ne fait qu'afficher.
   *
   * Existence + activité de la ville sont vérifiées côté service sur
   * `ServiceCity` (source de vérité), pas ici.
   */
  @IsOptional()
  @IsUUID()
  cityId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(ALLOWED_CATEGORIES, { each: true })
  categories?: string[];

  /**
   * Compétences par famille d'équipement structurée (§8) : codes
   * `EquipmentFamily`. Existence et activité vérifiées côté service (source
   * de vérité = la table), pas ici.
   *
   * VIDE = pas de préférence déclarée (le dispatch ne filtre pas par famille).
   * NON VIDE = filtrage strict sur ces codes.
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_FAMILY_CODES)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  familyCodes?: string[];

  @IsOptional()
  @IsBoolean()
  isAvailable?: boolean;

  /* `avatarUrl` n'est PAS modifiable ici : la photo de profil ne peut être
   * écrite que par `POST /technician/profile/avatar`, qui televerse l'image
   * dans le bucket contrôlé et en retourne l'URL. Accepter une URL libre ici
   * permettrait de faire pointer l'avatar vers n'importe quel hôte externe
   * ( trackers, contenu non lié à Relio) puisque `avatarUrl` est une URL
   * PUBLIQUE rendue dans le profil public. */

  @IsOptional()
  @IsString()
  @MaxLength(MAX_BIO_LENGTH)
  bio?: string | null;

  /** Récit libre historique (conservé) — l'expérience exploitable est `experienceYears`. */
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  experience?: string | null;

  /** Statut d'activité : indépendant, salarié, société ou autre (enum `TechnicianActivityType`). */
  @IsOptional()
  @IsIn(ACTIVITY_TYPES)
  activityType?: string | null;

  /** Expérience en années : structurée, exploitable, non ambiguë. */
  @IsOptional()
  @IsInt()
  @Min(MIN_EXPERIENCE_YEARS)
  @Max(MAX_EXPERIENCE_YEARS)
  experienceYears?: number | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  serviceDescription?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_SPECIALTIES)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  specialties?: string[];

  /* ── KYC : identité (page dédiée /technicien/kyc) ─────────────────── */

  /** Date de naissance `YYYY-MM-DD`. Source de vérité du contrôle de majorité. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Date de naissance invalide (AAAA-MM-JJ).' })
  birthDate?: string | null;

/**
 * Nationalité : code ISO 3166-1 alpha-2 issu de la nomenclature partagée
 * (`technician/nationalities.ts`). Liste fermée, pas « deux lettres » : sans
 * cela la colonne accepterait `ZZ` et le backoffice verrait une nationalité
 * inexistante.
 *
 * `@Transform` précède les validateurs : sans lui, `@IsIn` comparerait la
 * valeur BRUTE et rejetterait `'cm'` alors que le service sait normaliser.
 * La normalisation est donc faite une fois, avant validation ET avant
 * persistance (source unique).
 */
  @IsOptional()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @MaxLength(NATIONALITY_ALPHA2_LENGTH)
  @IsIn(NATIONALITY_CODE_LIST, {
    message: 'Nationalité inconnue (code ISO 3166-1 alpha-2 attendu).',
  })
  nationality?: string | null;

  /** Nature de la pièce d'identité : CNI (recto+verso) ou passeport (recto). */
  @IsOptional()
  @IsIn(IDENTITY_DOCUMENT_TYPES)
  kycIdentityDocType?: string | null;
}