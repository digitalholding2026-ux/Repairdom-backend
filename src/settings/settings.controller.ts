import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { SettingsService } from './settings.service.js';
import { PlatformSettingDto } from './dto/platform-setting.dto.js';
import { UpdatePlatformSettingDto } from './dto/update-platform-setting.dto.js';

/* Type minimale pour un fichier uploadé (remplace l’import de
 * @nestjs/platform-express). Seul le sous-ensemble utilisé est typé. */
export interface MulterFile {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/* Paramètres globaux de la plateforme.
 *
 * - GET /api/public/settings : public, renvoie uniquement adminName,
 *   adminWhatsApp, adminAvatarUrl (pour le frontend client).
 * - GET /api/admin/settings : protégé ADMIN, renvoie tous les champs.
 * - PATCH /api/admin/settings : protégé ADMIN, met à jour les paramètres.
 * - POST /api/settings/avatar : protégé ADMIN, upload une photo d’avatar.
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

  /* Upload d’avatar admin (multipart/form-data).
   * Stocke l’image dans Supabase et met à jour adminAvatarUrl. */
  @Post('avatar')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('ADMIN')
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: 5 * 1024 * 1024 },
      fileFilter(_request, file, callback) {
        const allowed = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowed.includes(file.mimetype)) {
          callback(
            new BadRequestException('Format non supporté. Formats acceptés : JPG, PNG, WEBP.'),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  async uploadAdminAvatar(@UploadedFile() file?: MulterFile): Promise<{ adminAvatarUrl: string }> {
    const url = await this.settings.uploadAvatar(file);
    return { adminAvatarUrl: url };
  }
}
