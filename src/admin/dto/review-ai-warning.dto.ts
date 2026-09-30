import { IsOptional, IsString, MaxLength } from 'class-validator';

/* IA-7 — revue humaine d'un avertissement tarifaire (décision conservée,
 * événement initial intact, jamais de sanction automatique). */
export class ReviewAiWarningDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;
}
