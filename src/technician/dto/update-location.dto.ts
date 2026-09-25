import { IsNumber, Max, Min } from 'class-validator';

/* GPS V1 — dernière position connue du technicien (transmission explicite
 * et ponctuelle, jamais de tracking). Les deux champs sont requis ensemble ;
 * bornes strictes, NaN/Infinity refusés. */
export class UpdateTechnicianLocationDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude!: number;
}
