import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import type { Response } from 'express';
import { PrismaService } from './../prisma/prisma.service.js';
import { hashPassword, verifyPassword } from './password-hash.js';
import {
  COOKIE_MAX_AGE_MS,
  COOKIE_NAME,
  type AuthUser,
  type RequestUser,
  type UserRole,
} from './auth.types.js';
import type { RegisterDto } from './dto/register.dto.js';
import type { LoginDto } from './dto/login.dto.js';
import type { UpdateMeDto } from './dto/update-me.dto.js';
import { EmailService } from './email.service.js';
import {
  AVATAR_EXTENSION_BY_MIME,
  MAX_AVATAR_SIZE,
  isAllowedAvatarMimetype,
  isImageBuffer,
  type UploadedAvatarFile,
} from '../technician/avatar-file.js';
import { AVATAR_BUCKET, SupabaseStorageService } from '../technician/supabase-storage.service.js';

const EMAIL_INVALID_OR_EXPIRED =
  'Ce lien de vérification est invalide ou a expiré. Demandez un nouveau lien.';
const EMAIL_VERIFICATION_REQUIRED =
  'Votre adresse email doit être vérifiée avant de pouvoir accéder à RepairDom.';
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtSecret: string;
  private readonly expiresIn: string;
  private readonly isProduction: boolean;
  private readonly frontendUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly storage: SupabaseStorageService,
  ) {
    this.isProduction = this.config.get<string>('NODE_ENV') === 'production';
    this.frontendUrl =
      this.config.get<string>('FRONTEND_URL')?.replace(/\/+$/, '') ?? 'https://repairdom.vercel.app';
    const configured = this.config.get<string>('JWT_SECRET');
    if (!configured && this.isProduction) {
      throw new Error(
        'JWT_SECRET is required in production. Define it (Railway → Variables) before starting.',
      );
    }
    if (!configured) {
      const fallback = randomBytes(32).toString('base64');
      this.logger.warn(
        'JWT_SECRET non définie — clé secrète aléatoire générée au démarrage. ' +
          'Les sessions ne survivront pas à un redéploiement. ' +
          'Définir JWT_SECRET (Railway → Variables) pour des sessions stables.',
      );
      this.jwtSecret = fallback;
    } else {
      this.jwtSecret = configured;
    }
    this.expiresIn = this.config.get<string>('JWT_EXPIRES_IN') ?? '7d';
  }

  private toAuthUser(user: {
    id: string;
    role: string;
    firstName: string;
    lastName: string | null;
    phone: string | null;
    email: string;
    emailVerified: boolean;
    avatarUrl: string | null;
    city: string | null;
    address: string | null;
    whatsapp: string | null;
    createdAt: Date;
  }): AuthUser {
    return {
      id: user.id,
      role: user.role as UserRole,
      firstName: user.firstName,
      lastName: user.lastName,
      phone: user.phone,
      email: user.email,
      emailVerified: user.emailVerified,
      avatarUrl: user.avatarUrl,
      city: user.city,
      address: user.address,
      whatsapp: user.whatsapp,
      createdAt: user.createdAt,
    };
  }

  async register(dto: RegisterDto): Promise<AuthUser> {
    const isTechnician = dto.role === 'TECHNICIAN';

    if (isTechnician) {
      if (!dto.phone?.trim()) {
        throw new BadRequestException('Le téléphone est requis pour un compte technicien.');
      }
      if (!dto.city?.trim()) {
        throw new BadRequestException("La ville d'intervention est requise.");
      }
      if (!dto.categories || dto.categories.length === 0) {
        throw new BadRequestException('Sélectionnez au moins une catégorie de réparation.');
      }
    }

    if (!isTechnician) {
      if (!dto.city?.trim()) {
        throw new BadRequestException("Veuillez renseigner votre ville.");
      }
      if (!dto.address?.trim()) {
        throw new BadRequestException('Veuillez renseigner votre adresse précise.');
      }
    }

    const passwordHash = await hashPassword(dto.password);

    // Comptes CLIENT : vérification email obligatoire avant premier accès.
    // Les techniciens sont vérifiés d'office (parcours approuvé par l'admin).
    const requireEmailVerification = !isTechnician;
    const emailVerificationToken = requireEmailVerification
      ? randomBytes(24).toString('hex')
      : null;

    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            firstName: dto.firstName.trim(),
            lastName: dto.lastName.trim(),
            phone: dto.phone ?? null,
            whatsapp: dto.whatsapp ?? null,
            city: dto.city?.trim() ?? null,
            address: dto.address?.trim() ?? null,
            email: dto.email.toLowerCase().trim(),
            passwordHash,
            role: isTechnician ? 'TECHNICIAN' : 'CLIENT',
            emailVerified: !requireEmailVerification,
            emailVerificationToken,
            emailVerificationExpiresAt: requireEmailVerification
              ? new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS)
              : null,
          },
        });

        if (isTechnician) {
          await tx.technicianProfile.create({
            data: {
              userId: created.id,
              city: dto.city!.trim(),
              categories: dto.categories!,
            },
          });
        }

        return created;
      });

      if (requireEmailVerification && emailVerificationToken) {
        const link = `${this.frontendUrl}/client/verification?token=${emailVerificationToken}`;
        await this.email.sendVerificationEmail(user.email, link);
      }

      return this.toAuthUser(user);
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') {
        throw new ConflictException('Un compte existe déjà avec cette adresse e-mail.');
      }
      throw error;
    }
  }

  async login(dto: LoginDto): Promise<AuthUser> {
    const found = await this.prisma.user.findUnique({
      where: { email: dto.email.toLowerCase().trim() },
    });
    if (!found) throw new UnauthorizedException('Identifiants invalides.');

    const valid = await verifyPassword(dto.password, found.passwordHash);
    if (!valid) throw new UnauthorizedException('Identifiants invalides.');

    if (found.role === 'CLIENT' && !found.emailVerified) {
      throw new UnauthorizedException(EMAIL_VERIFICATION_REQUIRED);
    }

    return this.toAuthUser(found);
  }

  async me(id: string): Promise<AuthUser> {
    const found = await this.prisma.user.findUnique({ where: { id } });
    if (!found) throw new UnauthorizedException('Authentification requise.');
    return this.toAuthUser(found);
  }

  async verifyEmail(token: string): Promise<AuthUser> {
    const trimmed = token.trim();
    const found = await this.prisma.user.findFirst({
      where: { emailVerificationToken: trimmed },
    });
    if (
      !found ||
      !found.emailVerificationExpiresAt ||
      found.emailVerificationExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException(EMAIL_INVALID_OR_EXPIRED);
    }
    if (found.emailVerified) {
      throw new BadRequestException('Cette adresse email est déjà vérifiée.');
    }
    const updated = await this.prisma.user.update({
      where: { id: found.id },
      data: { emailVerified: true, emailVerificationToken: null, emailVerificationExpiresAt: null },
    });
    return this.toAuthUser(updated);
  }

  /** Renvoie le lien de validation sans jamais révéler si l'adresse existe. */
  async resendVerification(email: string): Promise<{ ok: boolean }> {
    const found = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim() },
    });
    if (found && found.role === 'CLIENT' && !found.emailVerified) {
      const token = randomBytes(24).toString('hex');
      await this.prisma.user.update({
        where: { id: found.id },
        data: {
          emailVerificationToken: token,
          emailVerificationExpiresAt: new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS),
        },
      });
      const link = `${this.frontendUrl}/client/verification?token=${token}`;
      await this.email.sendVerificationEmail(found.email, link);
    }
    return { ok: true };
  }

  async updateMe(id: string, dto: UpdateMeDto): Promise<AuthUser> {
    const found = await this.prisma.user.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('Compte introuvable.');
    const updated = await this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.firstName !== undefined ? { firstName: dto.firstName.trim() } : {}),
        ...(dto.lastName !== undefined
          ? { lastName: dto.lastName.trim() || null }
          : {}),
        ...(dto.phone !== undefined ? { phone: dto.phone?.trim() || null } : {}),
        ...(dto.whatsapp !== undefined
          ? { whatsapp: dto.whatsapp?.trim() || null }
          : {}),
        ...(dto.city !== undefined ? { city: dto.city?.trim() || null } : {}),
        ...(dto.address !== undefined ? { address: dto.address?.trim() || null } : {}),
      },
    });
    return this.toAuthUser(updated);
  }

  async uploadAvatar(userId: string, file: UploadedAvatarFile | undefined): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Compte introuvable.');
    if (!file) throw new BadRequestException('Fichier manquant.');
    if (!isAllowedAvatarMimetype(file.mimetype)) {
      throw new BadRequestException('Format non supporté. Formats acceptés : JPG, PNG, WEBP.');
    }
    if (file.size > MAX_AVATAR_SIZE) {
      throw new BadRequestException('Le fichier dépasse 5 Mo.');
    }
    if (!isImageBuffer(file.buffer)) {
      throw new BadRequestException('Le fichier n’est pas une image valide.');
    }
    if (!this.storage.isConfigured) {
      throw new ServiceUnavailableException('L’upload de photo n’est pas disponible pour le moment.');
    }

    const extension = AVATAR_EXTENSION_BY_MIME[file.mimetype];
    const path = `clients/${userId}/${randomUUID()}.${extension}`;
    await this.storage.uploadObject(path, file.buffer, file.mimetype);
    const avatarUrl = this.storage.publicUrl(path);
    const previousUrl = user.avatarUrl;

    await this.prisma.user.update({
      where: { id: userId },
      data: { avatarUrl },
    });

    if (previousUrl) {
      const previousPath = this.extractObjectPath(previousUrl);
      if (previousPath && previousPath !== path) {
        await this.storage.deleteObject(previousPath).catch(() => undefined);
      }
    }

    return this.me(userId);
  }

  private extractObjectPath(publicUrl: string): string | null {
    const marker = `/object/public/${AVATAR_BUCKET}/`;
    const index = publicUrl.indexOf(marker);
    return index >= 0 ? publicUrl.slice(index + marker.length) : null;
  }

  signToken(user: AuthUser): string {
    return jwt.sign(
      { sub: user.id, email: user.email, role: user.role },
      this.jwtSecret,
      { expiresIn: this.expiresIn as SignOptions['expiresIn'] },
    );
  }

  async verifyToken(token: string): Promise<RequestUser> {
    try {
      const payload = jwt.verify(token, this.jwtSecret) as { sub?: string };
      if (!payload.sub) throw new UnauthorizedException('Session invalide ou expirée.');
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user) throw new UnauthorizedException('Session invalide ou expirée.');
      return { id: user.id, email: user.email, role: user.role as UserRole };
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException('Session invalide ou expirée.');
    }
  }

  setAuthCookie(res: Response, token: string): void {
    const secure = this.isProduction;
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      secure,
      sameSite: secure ? 'none' : 'lax',
      path: '/',
      maxAge: COOKIE_MAX_AGE_MS,
    });
  }

  clearAuthCookie(res: Response): void {
    const secure = this.isProduction;
    res.clearCookie(COOKIE_NAME, {
      httpOnly: true,
      secure,
      sameSite: secure ? 'none' : 'lax',
      path: '/',
    });
  }
}