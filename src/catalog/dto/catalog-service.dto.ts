import { IsBoolean } from 'class-validator';

/* M1 — ouverture / fermeture d'une prestation du catalogue v2 par l'administration. */
export class UpdateCatalogServiceDto {
  @IsBoolean()
  active: boolean;
}