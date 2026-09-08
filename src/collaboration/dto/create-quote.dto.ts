import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export const QUOTE_MAX_AMOUNT = 1_000_000_000;
export const QUOTE_DESCRIPTION_MAX_LENGTH = 1000;

export class CreateQuoteDto {
  @IsInt()
  @Min(1)
  @Max(QUOTE_MAX_AMOUNT)
  amount: number;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(QUOTE_DESCRIPTION_MAX_LENGTH)
  description: string;
}