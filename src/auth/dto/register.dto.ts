import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/* Inscription : comptes CLIENT uniquement (Relio v2). Les comptes ADMIN sont
 * créés par l'administration, jamais par cette route. */
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

  /* Ville en texte libre. Le service la rattache au référentiel `ServiceCity`
   * quand la correspondance est unique (règle D du sprint 8.8.2), sans la
   * bloquer sinon : `cityId` reste null. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  city?: string;
}
