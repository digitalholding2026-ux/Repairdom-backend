import { IsString, IsOptional, IsUrl } from 'class-validator';

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
  adminAvatarUrl?: string | null;

  @IsOptional()
  @IsString()
  supportEmail?: string | null;
}
