import {
  IsArray,
  IsEmail,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ALLOWED_CATEGORIES } from '../../demandes/categories.js';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(80)
  firstName: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  @MaxLength(80)
  lastName: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  whatsapp?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string;

  @IsEmail()
  @MaxLength(200)
  email: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

  @IsOptional()
  @IsIn(['CLIENT', 'TECHNICIAN'])
  role?: 'CLIENT' | 'TECHNICIAN';

  /* ── Ville ──────────────────────────────────────────────────────────────
   *
   * Chantier #5B — la ville devient une RÉFÉRENCE structurée, plus un texte.
   *
   * `cityId` reste OPTIONNEL dans le DTO : celui-ci ne connaît pas le rôle,
   * or l'obligation est propre au TECHNICIAN (c'est lui qu'on doit géolocaliser
   * pour le dispatch). C'est `AuthService.register` qui l'exige pour ce seul
   * rôle — un CLIENT s'inscrit sans ville de référence. existence + activité
   * sont vérifiées côté service, sur la table : la source de vérité est
   * `ServiceCity`, jamais cette classe.
   */
  @IsOptional()
  @IsUUID()
  cityId?: string;

  /* Ville en texte libre : conservé (CLIENT, et repli d'historique). Pour un
   * technicien furnished avec `cityId`, c'est le service qui renseigne ce
   * champ depuis `ServiceCity.name` : le frontend ne l'envoie donc plus. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @IsIn(ALLOWED_CATEGORIES, { each: true })
  categories?: string[];
}