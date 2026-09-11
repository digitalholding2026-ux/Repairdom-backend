import {
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { MAX_TEST_CREDIT_AMOUNT } from '../financial-fees.js';

/** Crédit initial de simulation (ADMIN uniquement, mode SIMULATION). */
export class CreateTestCreditDto {
  @IsString()
  @IsNotEmpty()
  userId: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_TEST_CREDIT_AMOUNT)
  amount?: number;
}