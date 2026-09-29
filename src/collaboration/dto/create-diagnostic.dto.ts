import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const DIAGNOSTIC_MAX_LENGTH = 2000;

export class CreateDiagnosticDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(DIAGNOSTIC_MAX_LENGTH)
  content: string;

  @IsOptional()
  @IsString()
  @MaxLength(DIAGNOSTIC_MAX_LENGTH)
  recommendation?: string;

  /* IA-3 — note vocale facultative (chemin retourné par l'upload audio,
   * lié en transaction à la création ; jamais d'URL persistée). */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  audioStoragePath?: string;
}