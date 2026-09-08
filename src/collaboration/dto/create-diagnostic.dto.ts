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
}