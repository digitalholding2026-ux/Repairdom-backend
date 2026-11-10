import { IsString, IsOptional, IsUrl } from 'class-validator';

/* Paramètres globaux de la plateforme (singleton, id = "default").
 * Exposés au frontend client (public) et modifiables par l'admin. */
export class PlatformSettingDto {
  id: string;
  adminName: string;
  adminWhatsApp: string;
  adminAvatarUrl: string | null;
  supportEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/* Payload pour la mise à jour des paramètres (admin uniquement). */
export class UpdatePlatformSettingDto {
  @IsOptional()
  @IsString()
  adminName?: string;

  @IsOptional()
  @IsString()
  adminWhatsApp?: string;

  @IsOptional()
  @IsUrl()
  @IsOptional()
  adminAvatarUrl?: string | null;

  @IsOptional()
  @IsString()
  supportEmail?: string | null;
}
