import { IsEmail, IsString, MinLength } from 'class-validator';

/* Création d'un compte B2B par l'admin (POST /api/admin/clients/b2b).
 * Génère un mot de passe aléatoire et un proCode unique, puis renvoie
 * les identifiants à l'admin pour qu'il les communique au client. */
export class CreateB2BClientDto {
  @IsEmail()
  email: string;

  @IsString()
  @MinLength(1)
  firstName: string;

  @IsString()
  lastName?: string;

  @IsString()
  @MinLength(1)
  companyName: string;

  @IsString()
  phone?: string;
}
