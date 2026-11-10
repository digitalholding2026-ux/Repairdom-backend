import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { PlatformSettingDto } from './dto/platform-setting.dto.js';
import { UpdatePlatformSettingDto } from './dto/update-platform-setting.dto.js';

/* Paramètres globaux de la plateforme (singleton, id = "default").
 *
 * Le seed insère une ligne par défaut si la table est vide. Toutes les
 * méthodes de ce service opèrent sur cette unique ligne.
 */
@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /* Retourne les paramètres (créés par le seed si absents). */
  async getSettings(): Promise<PlatformSettingDto> {
    let setting = await this.prisma.platformSetting.findUnique({
      where: { id: 'default' },
    });

    if (!setting) {
      setting = await this.prisma.platformSetting.create({
        data: {
          id: 'default',
          adminName: 'Technicien Relio',
          adminWhatsApp: '237600000000',
          adminAvatarUrl: null,
          supportEmail: null,
        },
      });
    }

    return {
      id: setting.id,
      adminName: setting.adminName,
      adminWhatsApp: setting.adminWhatsApp,
      adminAvatarUrl: setting.adminAvatarUrl,
      supportEmail: setting.supportEmail,
      createdAt: setting.createdAt,
      updatedAt: setting.updatedAt,
    };
  }

  /* Met à jour les paramètres (admin uniquement). */
  async updateSettings(dto: UpdatePlatformSettingDto): Promise<PlatformSettingDto> {
    const setting = await this.prisma.platformSetting.upsert({
      where: { id: 'default' },
      update: {
        ...(dto.adminName !== undefined && { adminName: dto.adminName }),
        ...(dto.adminWhatsApp !== undefined && { adminWhatsApp: dto.adminWhatsApp }),
        ...(dto.adminAvatarUrl !== undefined && { adminAvatarUrl: dto.adminAvatarUrl }),
        ...(dto.supportEmail !== undefined && { supportEmail: dto.supportEmail }),
      },
      create: {
        id: 'default',
        adminName: dto.adminName ?? 'Technicien Relio',
        adminWhatsApp: dto.adminWhatsApp ?? '237600000000',
        adminAvatarUrl: dto.adminAvatarUrl ?? null,
        supportEmail: dto.supportEmail ?? null,
      },
    });

    return {
      id: setting.id,
      adminName: setting.adminName,
      adminWhatsApp: setting.adminWhatsApp,
      adminAvatarUrl: setting.adminAvatarUrl,
      supportEmail: setting.supportEmail,
      createdAt: setting.createdAt,
      updatedAt: setting.updatedAt,
    };
  }
}
