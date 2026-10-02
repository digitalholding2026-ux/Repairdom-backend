import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

/* Nouveau mot de passe : 8+ caractères, 1 majuscule, 1 minuscule, 1 chiffre
 * (miroir de `assertPasswordStrong` côté service — la validation DTO rejette
 * tôt, le service reste l'autorité). */
export class ResetPasswordDto {
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
  @Matches(/[A-Z]/, { message: 'Le mot de passe doit contenir au moins 1 majuscule.' })
  @Matches(/[a-z]/, { message: 'Le mot de passe doit contenir au moins 1 minuscule.' })
  @Matches(/[0-9]/, { message: 'Le mot de passe doit contenir au moins 1 chiffre.' })
  newPassword: string;
}
