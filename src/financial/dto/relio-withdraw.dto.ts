import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  RELIO_WITHDRAWAL_MAX_AMOUNT,
  RELIO_WITHDRAWAL_NOTE_MAX_LENGTH,
} from '../financial-fees.js';

/* Retrait des fonds Relio par l'admin. Montant entier XAF strictement
 * positif ; le backend refuse tout retrait supérieur au solde disponible
 * (vérification atomique sous verrou, dans la transaction). */
export class RelioWithdrawDto {
  @IsInt()
  @Min(1)
  @Max(RELIO_WITHDRAWAL_MAX_AMOUNT)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(RELIO_WITHDRAWAL_NOTE_MAX_LENGTH)
  note?: string;
}
