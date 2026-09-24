import { IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  MAX_TOPUP_AMOUNT,
  MIN_TOPUP_AMOUNT,
} from '../financial-fees.js';
import { SASPAY_TOPUP_NETWORKS } from '../../saspay/saspay-networks.js';

/** Création d'une intention de recharge (CLIENT). Aucun crédit ledger :
 *  l'intention reste PENDING jusqu'à confirmation serveur (webhook SasPay
 *  ou vérification serveur). En REAL, la création enchaîne l'initialisation
 *  softpay (réseau parmi le référentiel backend, téléphone du client). */
export class CreateTopupIntentDto {
  @IsInt()
  @Min(MIN_TOPUP_AMOUNT)
  @Max(MAX_TOPUP_AMOUNT)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(IDEMPOTENCY_KEY_MAX_LENGTH)
  idempotencyKey?: string;

  @IsOptional()
  @IsIn([...SASPAY_TOPUP_NETWORKS])
  network?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  firstName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  lastName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(150)
  email?: string;
}
