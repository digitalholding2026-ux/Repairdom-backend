import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';
import { DISPUTE_CATEGORIES, DISPUTE_DESCRIPTION_MAX, DISPUTE_DESCRIPTION_MIN } from '../dispute-constants.js';

/* Contestation client d'une mission COMPLETED (un seul litige par mission,
 * jamais supprimé). La catégorie et la description sont déclaratives :
 * c'est l'administration qui tranche, jamais le frontend. */
export class OpenDisputeDto {
  @IsIn([...DISPUTE_CATEGORIES])
  category!: (typeof DISPUTE_CATEGORIES)[number];

  @IsString()
  @MinLength(DISPUTE_DESCRIPTION_MIN)
  @MaxLength(DISPUTE_DESCRIPTION_MAX)
  description!: string;
}
