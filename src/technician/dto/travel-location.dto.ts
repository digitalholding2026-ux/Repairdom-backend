import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/* GPS V3 — position de déplacement liée à UNE mission (« Je suis en
 * route » + actualisations volontaires). Coordonnées requises ensemble ;
 * bornes strictes, NaN/Infinity refusés. La mission visée est désignée par
 * le paramètre de route `:id` ; l'auteur est le technicien JWT (aucun
 * identifiant de tiers accepté). */
export class TravelLocationDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude!: number;
}

/* GPS V3 — « Je suis arrivé » : la dernière position n'est enregistrée que
 * si l'autorisation GPS est disponible (coordonnées optionnelles) ; la
 * date d'arrivée est toujours enregistrée et clôt le déplacement. */
export class TravelArrivedDto {
  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude?: number;
}
