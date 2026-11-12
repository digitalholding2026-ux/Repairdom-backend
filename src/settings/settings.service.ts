import { Injectable, Logger, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { randomUUID } from 'node:crypto';
import { PlatformSettingDto } from './dto/platform-setting.dto.js';
import { UpdatePlatformSettingDto } from './dto/update-platform-setting.dto.js';
import { SupabaseStorageService } from '../storage/supabase-storage.service.js';

/* Type minimale pour un fichier uploadé (remplace l’import de
 * @nestjs/platform-express). Seul le sous-ensemble utilisé est typé. */
export interface MulterFile {
  mimetype: string;
  size: number;
  buffer: Buffer;
}

/* Paramètres globaux de la plateforme (singleton, id = "default").
 *
 * Le seed insère une ligne par défaut si la table est vide. Toutes les
 * méthodes de ce service opèrent sur cette unique ligne.
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: SupabaseStorageService,
  ) {}

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

  /* Upload d’avatar admin (multipart/form-data).
   * Stocke l’image dans Supabase (bucket repairdom-profile-images),
   * met à jour adminAvatarUrl et supprime l’ancienne photo si présente.
   * Retourne l’URL publique de l’avatar. */
  async uploadAvatar(file: MulterFile | undefined): Promise<string> {
    if (!file) {
      throw new BadRequestException('Fichier manquant.');
    }
    const allowed = ['image/jpeg', 'image/png', 'image/webp'];
    if (!allowed.includes(file.mimetype)) {
      throw new BadRequestException('Format non supporté. Formats acceptés : JPG, PNG, WEBP.');
    }
    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException('Le fichier dépasse 5 Mo.');
    }
    if (!file.buffer || !(file.buffer as Buffer).length) {
      throw new BadRequestException('Le fichier n’est pas une image valide.');
    }
    if (!this.storage.isConfigured) {
      throw new ServiceUnavailableException('L’upload de photo n’est pas disponible pour le moment.');
    }

    const extensionByMime: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
    };
    const extension = extensionByMime[file.mimetype];
    const path = `admin/avatar/${randomUUID()}.${extension}`;
    await this.storage.uploadObject(path, file.buffer, file.mimetype);
    const avatarUrl = this.storage.publicUrl(path);

    const existing = await this.prisma.platformSetting.findUnique({
      where: { id: 'default' },
    });
    const previousUrl = existing?.adminAvatarUrl ?? null;

    await this.prisma.platformSetting.upsert({
      where: { id: 'default' },
      update: { adminAvatarUrl: avatarUrl },
      create: {
        id: 'default',
        adminName: 'Technicien Relio',
        adminWhatsApp: '237600000000',
        adminAvatarUrl: avatarUrl,
        supportEmail: null,
      },
    });

    if (previousUrl) {
      const previousPath = this.storage.extractObjectPath(previousUrl);
      if (previousPath && previousPath !== path) {
        await this.storage.deleteObject(previousPath).catch(() => undefined);
      }
    }

    return avatarUrl;
  }
}
