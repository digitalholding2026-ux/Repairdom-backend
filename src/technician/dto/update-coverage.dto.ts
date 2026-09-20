import { ArrayMaxSize, ArrayUnique, IsArray, IsNotEmpty, IsString } from 'class-validator';

/* Sprint 8.8.2 — déclaration des zones couvertes par le technicien.
 * Liste idempotente : les doublons sont rejetés à la validation et la
 * soumission répétée du même contenu produit le même état. */
const MAX_COVERAGE_ZONES = 50;

export class UpdateCoverageDto {
  @IsArray()
  @ArrayMaxSize(MAX_COVERAGE_ZONES)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  zoneIds: string[];
}
