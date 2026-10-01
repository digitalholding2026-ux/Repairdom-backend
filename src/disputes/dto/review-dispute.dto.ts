import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/* Revue administrative d'un litige (ADMIN uniquement, jamais supprimé) :
 * - UNDER_REVIEW : prise en charge (sans décision) ;
 * - RESOLVED : fondé — libère le hold (fonds rendus au client) et bloque
 *   définitivement la confirmation ;
 * - REJECTED : non fondé — le client peut à nouveau confirmer.
 * `resolution` exigée pour RESOLVED/REJECTED, interdite pour UNDER_REVIEW
 * (contrôle service, comme la revue KYC). */
export class ReviewDisputeDto {
  @IsIn(['UNDER_REVIEW', 'RESOLVED', 'REJECTED'])
  decision!: 'UNDER_REVIEW' | 'RESOLVED' | 'REJECTED';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolution?: string;
}
