import { IsNumber, IsOptional, Max, Min } from 'class-validator';

/* GPS V3 — position de déplacement liée à UNE mission (« Je suis en
 * route » + actualisations volontaires). Coordonnées requises ensemble ;
 * bornes strictes, NaN/Infinity refusés. La mission visée est désignée par
 * le paramètre de route `:id` ; l'auteur est le technicien JWT (aucun
 * identifiant de tiers accepté).
 * CHANTIER GPS P0/P1 — `accuracy` optionnelle (mètres, valeur brute du
 * navigateur, jamais inventée) : permet au backend de refuser un fix trop
 * imprécis comme position « fraîche » sans bloquer l'action métier. */
export class TravelLocationDto {
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-90)
  @Max(90)
  latitude!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-180)
  @Max(180)
  longitude!: number;

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  accuracy?: number;
}

/* CHANTIER GPS P0/P1 — « Je suis en route » SANS GPS (permission refusée,
 * GPS désactivé, timeout, erreur navigateur) : le backend accepte un corps
 * vide et enregistre le départ sans coordonnées (aucun nouveau statut,
 * aucune position inventée). Avec coordonnées, même validation que
 * `TravelLocationDto`. */
export class TravelStartOptionalDto {
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

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  accuracy?: number;
}

/* GPS V3 — « Je suis arrivé » : la dernière position n'est enregistrée que
 * si l'autorisation GPS est disponible (coordonnées optionnelles) ; la
 * date d'arrivée est toujours enregistrée et clôt le déplacement.
 * CHANTIER GPS P0/P1 — `accuracy` optionnelle : un fix trop imprécis
 * n'est pas stocké (arrivée enregistrée sans position). */
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

  @IsOptional()
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(1_000_000)
  accuracy?: number;
}
