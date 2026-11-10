import {
  Body,
  Controller,
  Get,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { SettingsService } from './settings.service.js';
import { PlatformSettingDto } from './dto/platform-setting.dto.js';
import { UpdatePlatformSettingDto } from './dto/update-platform-setting.dto.js';

/* Paramètres globaux de la plateforme.
 *
 * - GET /api/public/settings : public, renvoie uniquement adminName,
 *   adminWhatsApp, adminAvatarUrl (pour le frontend client).
 * - GET /api/admin/settings : protégé ADMIN, renvoie tous les champs.
 * - PATCH /api/admin/settings : protégé ADMIN, met à jour les paramètres.
 */
@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  /* Lecture publique : paramètres exposés au frontend client.
   * Aucun secret n'est retourné (supportEmail, createdAt, updatedAt exclus). */
  @Get('public')
  async getPublicSettings(): Promise<Pick<PlatformSettingDto, 'adminName' | 'adminWhatsApp' | 'adminAvatarUrl'>> {
    const s = await this.settings.getSettings();
    return {
      adminName: s.adminName,
      adminWhatsApp: s.adminWhatsApp,
      adminAvatarUrl: s.adminAvatarUrl,
    };
  }

  /* Lecture admin : tous les champs. */
  @Get('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  async getAdminSettings(): Promise<PlatformSettingDto> {
    return this.settings.getSettings();
  }

  /* Mise à jour admin. */
  @Patch('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  async updateAdminSettings(
    @Body() dto: UpdatePlatformSettingDto,
  ): Promise<PlatformSettingDto> {
    return this.settings.updateSettings(dto);
  }
}
