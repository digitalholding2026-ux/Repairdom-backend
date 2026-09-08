import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
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

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly jwtSecret: string;
  private readonly expiresIn: string;
  private readonly isProduction: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.isProduction = this.config.get<string>('NODE_ENV') === 'production';
    const configured = this.config.get<string>('JWT_SECRET');
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
    phone: string | null;
    email: string;
    createdAt: Date;
  }): AuthUser {
    return {
      id: user.id,
      role: user.role as UserRole,
      firstName: user.firstName,
      phone: user.phone,
      email: user.email,
      createdAt: user.createdAt,
    };
  }

  async register(dto: RegisterDto): Promise<AuthUser> {
    const isTechnician = dto.role === 'TECHNICIAN';

    if (isTechnician) {
      if (!dto.lastName?.trim()) {
        throw new BadRequestException('Le nom est requis pour un compte technicien.');
      }
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

    const passwordHash = await hashPassword(dto.password);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            firstName: dto.firstName,
            lastName: dto.lastName?.trim() || null,
            phone: dto.phone ?? null,
            email: dto.email.toLowerCase().trim(),
            passwordHash,
            role: isTechnician ? 'TECHNICIAN' : 'CLIENT',
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

    return this.toAuthUser(found);
  }

  async me(id: string): Promise<AuthUser> {
    const found = await this.prisma.user.findUnique({ where: { id } });
    if (!found) throw new UnauthorizedException('Authentification requise.');
    return this.toAuthUser(found);
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