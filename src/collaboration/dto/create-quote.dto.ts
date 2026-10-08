import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';
import { MIN_QUOTE_AMOUNT_XAF } from '../../financial/fee-calculator.js';

export const QUOTE_MAX_AMOUNT = 1_000_000_000;
export const QUOTE_DESCRIPTION_MAX_LENGTH = 1000;

export class CreateQuoteDto {
  /* Chantier 4-FONDATIONS-A — seuil minimum d'intervention. Le garde métier
   * (message explicite « Le montant minimum d'une intervention est de
   * 5 000 FCFA. ») est aussi posé dans `CollaborationService.createQuote()` :
   * cette contrainte `@Min` est la première barrière, celle du service donne
   * le message métier lu par l'utilisateur. */
  @IsInt()
  @Min(MIN_QUOTE_AMOUNT_XAF)
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