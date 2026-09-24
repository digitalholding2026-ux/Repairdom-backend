import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  MAX_TOPUP_AMOUNT,
  MIN_TOPUP_AMOUNT,
} from '../financial-fees.js';

/** Création d'une intention de recharge (CLIENT). Aucun crédit ledger :
 *  l'intention reste PENDING jusqu'à confirmation serveur (webhook). */
export class CreateTopupIntentDto {
  @IsInt()
  @Min(MIN_TOPUP_AMOUNT)
  @Max(MAX_TOPUP_AMOUNT)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(IDEMPOTENCY_KEY_MAX_LENGTH)
  idempotencyKey?: string;
}
