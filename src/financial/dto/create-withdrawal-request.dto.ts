import { IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  MAX_WITHDRAWAL_AMOUNT,
  MIN_WITHDRAWAL_AMOUNT,
} from '../financial-fees.js';
import { SASPAY_PAYOUT_NETWORKS } from '../../saspay/saspay-networks.js';

/** Création d'une demande de retrait (CLIENT/TECHNICIAN). Crée un hold
 *  ACTIVE + une demande PENDING : aucun débit tant que le payout SasPay
 *  n'est pas confirmé en SUCCESS. En REAL, enchaîne l'init payout
 *  (réseau parmi le référentiel backend CM/mtn_cm/orange_cm, MSISDN
 *  bénéficiaire). Le compte est toujours dérivé du JWT : un CLIENT ne peut
 *  créer que pour lui-même (idem TECHNICIAN). */
export class CreateWithdrawalRequestDto {
  @IsInt()
  @Min(MIN_WITHDRAWAL_AMOUNT)
  @Max(MAX_WITHDRAWAL_AMOUNT)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(IDEMPOTENCY_KEY_MAX_LENGTH)
  idempotencyKey?: string;

  @IsOptional()
  @IsIn([...SASPAY_PAYOUT_NETWORKS])
  network?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  msisdn?: string;
}
