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
  MinLength,
} from 'class-validator';
import { ALLOWED_CATEGORIES } from '../categories.js';

/* Chantier D1 — base commune des payloads de demande.
 *
 * Les CONSTANTES vivent ici (et non dans `create-demande.dto.ts`) pour éviter
 * un cycle d'import ESM : `create-demande.dto.ts` importe `BaseDemandeDto`
 * depuis ce fichier, donc ce fichier ne peut pas importer les constantes
 * depuis `create-demande.dto.ts`. Elles sont ré-exportées là-bas pour
 * préserver les imports existants de tout le dépôt.
 */
export const REQUEST_TIMINGS = ['ASAP', 'SCHEDULED'] as const;

/* POURQUOI CE FICHIER EXISTE : le brouillon non authentifié et la demande
 * authentifiée portent EXACTEMENT les mêmes champs, aux mêmes contraintes.
 * Dupliquer 120 lignes de décorateurs entre `CreateDemandeDto` et
 * `CreateDemandeDraftDto` aurait garanti qu'un jour les deux divergent — et
 * un brouillon validé par un DTO puis refusé à la conversion (ou l'inverse)
 * est un bug invisible jusqu'à la prod. class-validator hérite des décorateurs
 * du parent : les règles ci-dessous s'appliquent donc telles quelles aux
 * sous-classes.
 *
 * CE QUI RESTE HORS DE LA BASE, et pourquoi :
 *  - `medias` : absent du brouillon. Décision D1-2, les médias sont reportés
 *    après inscription (upload authentifié via `POST /demandes/medias/upload`).
 *    La conversion les reçoit dans `ConvertDemandeDraftDto`.
 *  - `modelId` / `problemId` : acceptés par la demande pour compatibilité
 *    (anciens clients, flux technicien), jamais produits par le wizard client.
 *    Un brouillon n'a donc pas à les porter.
 *  - `zoneId` :idem — le wizard ne le produit pas ; la demande le conserve
 *    pour les demandes historiques et le flux technicien.
 */
export class BaseDemandeDto {
  @IsIn(ALLOWED_CATEGORIES)
  categoryId: string;

  /* Appareil (catalogue) — parcours client simplifié : catégorie (domaine)
   * + marque réelle et active obligatoires côté service quand un domaine est
   * fourni ; `modelId`/`problemId` restent acceptés pour compatibilité
   * (anciens clients, flux technicien) mais ne sont plus demandés au client.
   * Sans domaine (hors catalogue), `equipmentFamily` (indice structuré) est
   * exigé quand la catégorie vaut `autre`. */
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

  /* Description libre du problème, en langage naturel.
   *
   * OBLIGATOIRE (10 caractères minimum, 1000 maximum) : c'est la seule source
   * de contexte lisible par le dispatch et par le technicien. Le wizard
   * client l'exige déjà depuis l'étape « Votre panne » ; la règle est donc
   * portée ici pour que TOUT appelant la respecte, y compris un appel direct
   * à l'API qui contournerait l'interface.
   *
   * Rappel : un dossier sans description texte ne peut pas être classifié et
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
  @IsIn(REQUEST_TIMINGS)
  requestedMode?: (typeof REQUEST_TIMINGS)[number];

  @IsOptional()
  @IsDateString()
  requestedAt?: string;
}