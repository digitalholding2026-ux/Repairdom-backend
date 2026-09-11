import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

/** Filtres de supervision financière ADMIN, appliqués côté backend. */
export class AdminFinanceQueryDto {
  @IsOptional()
  @IsIn(['SIMULATION', 'REAL'])
  mode?: 'SIMULATION' | 'REAL';

  @IsOptional()
  @IsISO8601()
  from?: string;

  @IsOptional()
  @IsISO8601()
  to?: string;

  @IsOptional()
  @IsString()
  @MaxLength(12)
  reference?: string;
}