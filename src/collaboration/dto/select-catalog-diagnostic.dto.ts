import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const SELECT_MODES = ['CATALOG', 'MANUAL'] as const;
export type SelectMode = (typeof SELECT_MODES)[number];

/* Sélection du diagnostic de mission (Sprint 8.1, enrichi Sprint 8.4).
 *
 * CATALOG : le technicien choisit un diagnostic + intervention du catalogue
 *           → RepairDom crée un Diagnostic mission + un tarif auto (snapshot).
 * MANUAL  : « diagnostic non référencé » (Sprint 8.4). Déclaré librement par
 *           le technicien avec l'intervention proposée, sa justification et
 *           une note libre. SANS tarif auto : le technicien garde la main
 *           (« tarif manuel » réservé au parcours non référencé).
 */
export class SelectCatalogDiagnosticDto {
  @IsIn(SELECT_MODES)
  mode: SelectMode;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  catalogDiagnosticId?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  catalogInterventionId?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  content?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  recommendation?: string;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  proposedIntervention?: string;

  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  justification?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}