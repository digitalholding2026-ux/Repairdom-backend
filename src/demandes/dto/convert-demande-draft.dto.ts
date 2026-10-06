import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, ValidateNested } from 'class-validator';
import { RequestMediaDto, MAX_MEDIA_FILES } from './create-demande.dto.js';

/* Chantier D1 — conversion du brouillon en vraie demande.
 *
 * Le corps ne porte QUE les médias. Ils ne sont pas dans le brouillon
 * (décision D1-2) : l'utilisateur les sélectionne dans le wizard, puis les
 * dépose une fois connecté, via l'endpoint existant
 * `POST /demandes/medias/upload`. Chaque `storagePath` retourné par cet
 * endpoint est renvoyé ici pour être lié à la `Demande` créée — exactement le
 * même contrat que `POST /demandes`, donc même code de validation
 * (`RequestMediaDto` réutilisé à l'identique, aucune redéfinition).
 *
 * Tous les champs du wizard sont repris depuis la ligne `DemandeDraft` : ce
 * DTO ne peut pas les surcharger, sinon la source de vérité du brouillon
 * deviendrait ambiguë.
 */
export class ConvertDemandeDraftDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_FILES)
  @ValidateNested({ each: true })
  @Type(() => RequestMediaDto)
  medias?: RequestMediaDto[];
}