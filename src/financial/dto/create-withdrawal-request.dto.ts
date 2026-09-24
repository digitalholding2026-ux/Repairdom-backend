import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  MAX_WITHDRAWAL_AMOUNT,
  MIN_WITHDRAWAL_AMOUNT,
} from '../financial-fees.js';

/** Création d'une demande de retrait (CLIENT/TECHNICIAN). Crée un hold
 *  ACTIVE + une demande PENDING : aucun débit tant que le payout SasPay
 *  n'est pas confirmé en SUCCESS. */
export class CreateWithdrawalRequestDto {
  @IsInt()
  @Min(MIN_WITHDRAWAL_AMOUNT)
  @Max(MAX_WITHDRAWAL_AMOUNT)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(IDEMPOTENCY_KEY_MAX_LENGTH)
  idempotencyKey?: string;
}
