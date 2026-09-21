import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const QUOTE_MAX_AMOUNT = 1_000_000_000;
export const QUOTE_DESCRIPTION_MAX_LENGTH = 1000;

export class CreateQuoteDto {
  @IsInt()
  @Min(1)
  @Max(QUOTE_MAX_AMOUNT)
  amount: number;

  // Règle Relio : le transport standard (2 000 XAF) est figé par le backend.
  // Champ conservé pour compatibilité d'API mais ignoré dans le calcul : le
  // montant `amount` EST la réparation, quel que soit le devis (CATALOG/MANUAL).
  @IsOptional()
  @IsInt()
  @Min(0)
  travelAmount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(QUOTE_DESCRIPTION_MAX_LENGTH)
  description: string;
}