import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
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
import { findActiveCityById, resolveCityId } from '../geo/city-reference.js';
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
  'Votre adresse email doit être vérifiée avant de pouvoir accéder à Relio.';
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/* Reset password — politique (sans dépendance externe) :
 * - token opaque 32 octets, expiration 1 h (surchargée par
 *   PASSWORD_RESET_TOKEN_TTL_MS, bornée [5 min, 24 h]) ;
 * - rate-limiting en base (PasswordResetAttempt) : 3 demandes/heure/e-mail,
 *   10 demandes/heure/IP ;
 * - mot de passe fort : 8+ caractères, 1 majuscule, 1 minuscule, 1 chiffre
 *   (au-delà du min 8 de l'inscription, exigé ici explicitement). */
const PASSWORD_RESET_DEFAULT_TTL_MS = 60 * 60 * 1000;
const PASSWORD_RESET_MIN_TTL_MS = 5 * 60 * 1000;
const PASSWORD_RESET_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_MAX_PER_EMAIL_PER_HOUR = 3;
const PASSWORD_RESET_MAX_PER_IP_PER_HOUR = 10;
/* Rétention du journal de rate-limiting : 24 h (au-delà du besoin de la
 * fenêtre de comptage d'1 h, sans cron ni tâche planifiée — nettoyage
 * opportuniste à chaque demande, best-effort). */
const PASSWORD_RESET_ATTEMPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const RESET_LINK_INVALID_OR_EXPIRED =
  'Ce lien a expiré ou est invalide. Demandez un nouveau lien.';
export const PASSWORD_STRENGTH_MESSAGE =
  'Le mot de passe doit contenir au moins 8 caractères, 1 majuscule, 1 minuscule et 1 chiffre.';

/** Règle de robustesse partagée (service + DTO) : jamais de mot de passe
 *  faible accepté, message unique et actionnable. */
export function assertPasswordStrong(password: string): void {
  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    password.length > 128 ||
    !/[A-Z]/.test(password) ||
    !/[a-z]/.test(password) ||
    !/[0-9]/.test(password)
  ) {
    throw new BadRequestException(PASSWORD_STRENGTH_MESSAGE);
  }
}

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
    // Base des liens e-mail (vérification). En production, définir
    // FRONTEND_URL (jamais l'ancien domaine public).
    this.frontendUrl =
      this.config.get<string>('FRONTEND_URL')?.replace(/\/+$/, '') ?? 'https://relioo.space';
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
    tokenVersion: number;
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
      tokenVersion: user.tokenVersion,
    };
  }

  async register(dto: RegisterDto): Promise<AuthUser> {
    const isTechnician = dto.role === 'TECHNICIAN';

    // Robustesse alignée sur reset-password : un mot de passe accepté à
    // l'inscription doit aussi être accepté à la réinitialisation.
    assertPasswordStrong(dto.password);
    if (isTechnician) {
      if (!dto.phone?.trim()) {
        throw new BadRequestException('Le téléphone est requis pour un compte technicien.');
      }
      /* Chantier #5B — la ville n'est plus un texte : c'est une RÉFÉRENCE
       * obligatoire. Sans elle, le technicien n'apparaît dans aucun filtre
       * ville et ne peut couvrant aucune zone : il ne recevrait jamais de
       * mission. Le texte libre ne suffisait pas (cf. Problème 1 de l'audit :
       * ville non rattachée au référentiel). */
      if (!dto.cityId) {
        throw new BadRequestException('Ville obligatoire pour un compte technicien.');
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

    /* ── Ville : deux régimes distincts, jamais mélangés ──
     *
     * TECHNICIAN (#5B) : la ville est une référence ASSERTÉE. `cityId` est
     * obligatoire (garde ci-dessus) et DOIT exister et être active : on
     * refuse l'inscription plutôt que d'enregistrer un compte que le dispatch
     * ne pourra jamais géolocaliser. Le texte `city` n'est plus une saisie :
     * il est dérivé du `ServiceCity.name`, ce qui garantit que l'affichage et
     * le référentiel ne peuvent pas diverger (« Douala » vs « douala »).
     *
     * CLIENT : comportement INCHANGÉ. Le texte reste saisi librement et n'est
     * rattaché au référentiel que si la correspondance est unique (règle D
     * du sprint 8.8.2, non bloquante) — sinon `cityId` reste null.
     */
    let cityText: string | null;
    let cityId: string | null;
    if (isTechnician) {
      const reference = await findActiveCityById(this.prisma, dto.cityId);
      if (!reference) {
        throw new BadRequestException('Ville introuvable.');
      }
      cityId = reference.id;
      cityText = reference.name;
    } else {
      cityText = dto.city?.trim() || null;
      cityId = await resolveCityId(this.prisma, cityText);
    }

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
            city: cityText,
            cityId,
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
              /* `cityText` vient de `ServiceCity.name` (cf. bloc ville) :
               * plus de `dto.city!`, qui n'est plus envoyé par le frontend. */
              city: cityText!,
              cityId,
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

    // Sprint ADMIN SUPER POWERS : un compte désactivé par l'admin ne peut
    // plus se connecter (ses données historiques restent conservées).
    if (found.isActive === false) {
      throw new ForbiddenException('Ce compte a été désactivé. Contactez Relio.');
    }

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
    if (found.isActive === false) {
      throw new ForbiddenException('Ce compte a été désactivé. Contactez Relio.');
    }
    return this.toAuthUser(found);
  }

  /* CHANTIER FIX — token rejouable, vérification idempotente.
   *
   * LE PROBLÈME : le token était mis à `null` dès la première vérification.
   * Un rejeu du même lien (préchargement par un scanner e-mail, double
   * navigateur, utilisateur qui reclique) ne trouvait donc PLUS aucun compte et
   * tombait sur « lien invalide ou expiré » — un message FASSE, alors que le
   * compte était parfaitement vérifié. Le branche `if (found.emailVerified)`
   * sous le `null` était donc du code mort : inatteignable en pratique.
   *
   * LE CORRECTIF : le token est CONSERVÉ après vérification. Il ne sert plus à
   * rien une fois l'adresse vérifiée — la ligne `emailVerified` ci-dessous est
   * la seule qui autorise quoi que ce soit — mais il reste une clé de
   * recherche, ce qui permet de répondre honnêtement « déjà vérifiée » au
   * lieu d'un 400 trompeur.
   *
   * SÉCURITÉ : conserver le token n'ouvre rien. Il n'accorde aucun droit une
   * fois `emailVerified === true`, il ne permet ni connexion ni accès. Un
   * nouveau lien (renvoi ou relance) écrase l'ancien, donc un token fuite ne
   * reste pas exploitable indéfiniment.
   *
   * ORDRE DES VÉRIFICATIONS : « déjà vérifiée » est testé AVANT l'expiration.
   * Le cas le plus fréquent est un lien rejoué des jours plus tard : exiger
   * une expiration valide renverrait à nouveau vers le message trompeur.
   */
  async verifyEmail(token: string): Promise<{ user: AuthUser; alreadyVerified: boolean }> {
    const trimmed = token.trim();
    const found = await this.prisma.user.findFirst({
      where: { emailVerificationToken: trimmed },
    });
    if (!found) {
      throw new BadRequestException(EMAIL_INVALID_OR_EXPIRED);
    }
    /* Idempotent : rien à réécrire, la session est rétablie normalement. */
    if (found.emailVerified) {
      return { user: this.toAuthUser(found), alreadyVerified: true };
    }
    if (
      !found.emailVerificationExpiresAt ||
      found.emailVerificationExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException(EMAIL_INVALID_OR_EXPIRED);
    }
    const updated = await this.prisma.user.update({
      where: { id: found.id },
      data: { emailVerified: true },
    });
    return { user: this.toAuthUser(updated), alreadyVerified: false };
  }

  /** Renvoie le lien de validation sans jamais révéler si l'adresse existe. */
  async resendVerification(email: string): Promise<{ ok: boolean }> {    const found = await this.prisma.user.findUnique({
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

  private passwordResetTtlMs(): number {
    const raw = Number(this.config.get<string>('PASSWORD_RESET_TOKEN_TTL_MS'));
    if (!Number.isFinite(raw)) return PASSWORD_RESET_DEFAULT_TTL_MS;
    return Math.min(
      Math.max(Math.round(raw), PASSWORD_RESET_MIN_TTL_MS),
      PASSWORD_RESET_MAX_TTL_MS,
    );
  }

  /* Demande de réinitialisation : réponse TOUJOURS identique (`{ ok: true }`),
   * que l'e-mail existe ou non (anti-énumération). Le token n'est JAMAIS
   * journalisé. Rate-limiting en base : 3/heure/e-mail, 10/heure/IP (429). */
  async requestPasswordReset(email: string, ip?: string): Promise<{ ok: boolean }> {
    const normalized = email.toLowerCase().trim();
    const since = new Date(Date.now() - 60 * 60 * 1000);
    // Cleanup opportuniste (pas de cron) : purge les tentatives de plus de
    // 24 h pour borner la table technique. Best-effort, jamais bloquant.
    await this.prisma.passwordResetAttempt
      .deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - PASSWORD_RESET_ATTEMPT_RETENTION_MS) } },
      })
      .catch(() => undefined);
    const [emailCount, ipCount] = await Promise.all([
      this.prisma.passwordResetAttempt.count({
        where: { email: normalized, createdAt: { gte: since } },
      }),
      ip
        ? this.prisma.passwordResetAttempt.count({
            where: { ip, createdAt: { gte: since } },
          })
        : Promise.resolve(0),
    ]);
    if (
      emailCount >= PASSWORD_RESET_MAX_PER_EMAIL_PER_HOUR ||
      ipCount >= PASSWORD_RESET_MAX_PER_IP_PER_HOUR
    ) {
      throw new HttpException(
        'Trop de demandes. Réessayez dans une heure.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    await this.prisma.passwordResetAttempt.create({
      data: { email: normalized, ip: ip ?? null },
    });

    const found = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    if (found) {
      const token = randomBytes(32).toString('hex');
      await this.prisma.user.update({
        where: { id: found.id },
        data: {
          passwordResetToken: token,
          passwordResetExpiresAt: new Date(Date.now() + this.passwordResetTtlMs()),
        },
      });
      const link = `${this.frontendUrl}/reinitialiser-mot-de-passe?token=${token}`;
      await this.email.sendPasswordResetEmail(found.email, found.firstName, link);
    }
    return { ok: true };
  }

  /** Validité d'un lien (utilisée par le frontend avant d'afficher le formulaire). */
  async validateResetToken(token: string): Promise<{ valid: boolean }> {
    const trimmed = token.trim();
    if (!trimmed) return { valid: false };
    const found = await this.prisma.user.findFirst({
      where: { passwordResetToken: trimmed },
    });
    if (
      !found ||
      !found.passwordResetExpiresAt ||
      found.passwordResetExpiresAt.getTime() < Date.now()
    ) {
      return { valid: false };
    }
    return { valid: true };
  }

  /* Réinitialisation : token à usage UNIQUE (effacé après usage),
   * `tokenVersion` incrémentée → TOUTES les sessions existantes invalidées.
   * Le rôle est renvoyé pour rediriger vers la bonne page de connexion. */
  async resetPassword(
    token: string,
    newPassword: string,
  ): Promise<{ ok: boolean; role: UserRole }> {
    assertPasswordStrong(newPassword);
    const trimmed = token.trim();
    const found = await this.prisma.user.findFirst({
      where: { passwordResetToken: trimmed },
    });
    if (
      !found ||
      !found.passwordResetExpiresAt ||
      found.passwordResetExpiresAt.getTime() < Date.now()
    ) {
      throw new BadRequestException(RESET_LINK_INVALID_OR_EXPIRED);
    }
    const passwordHash = await hashPassword(newPassword);
    const updated = await this.prisma.user.update({
      where: { id: found.id },
      data: {
        passwordHash,
        passwordResetToken: null,
        passwordResetExpiresAt: null,
        tokenVersion: { increment: 1 },
      },
    });
    return { ok: true, role: updated.role as UserRole };
  }

  async updateMe(id: string, dto: UpdateMeDto): Promise<AuthUser> {
    const found = await this.prisma.user.findUnique({ where: { id } });
    if (!found) throw new NotFoundException('Compte introuvable.');
    // Sprint 8.8.2 (règle D) — la ville textuelle reste la donnée saisie ;
    // `cityId` est (re)résolu à chaque modification : texte non résolu ou vide
    // → null, sans rejeter la mise à jour (un texte modifié doit effacer un
    // `cityId` devenu obsolète plutôt que de le conserver).
    const cityText = dto.city !== undefined ? dto.city?.trim() || null : undefined;
    const cityId = dto.city !== undefined ? await resolveCityId(this.prisma, cityText) : undefined;
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
        ...(dto.city !== undefined ? { city: cityText, cityId } : {}),
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
      { sub: user.id, email: user.email, role: user.role, tokenVersion: user.tokenVersion },
      this.jwtSecret,
      { expiresIn: this.expiresIn as SignOptions['expiresIn'] },
    );
  }

  async verifyToken(token: string): Promise<RequestUser> {
    try {
      const payload = jwt.verify(token, this.jwtSecret) as { sub?: string; tokenVersion?: unknown };
      if (!payload.sub) throw new UnauthorizedException('Session invalide ou expirée.');
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user) throw new UnauthorizedException('Session invalide ou expirée.');
      // Sprint ADMIN SUPER POWERS : les sessions existantes d'un compte
      // désactivé sont révoquées (pas seulement le login).
      if (user.isActive === false) {
        throw new UnauthorizedException('Session invalide ou expirée.');
      }
      // Reset password : tout JWT émis avant l'incrémentation de
      // `tokenVersion` est rejeté (toutes sessions invalidées). Les JWT
      // antérieurs au chantier (sans version) valent version 0.
      const presented = typeof payload.tokenVersion === 'number' ? payload.tokenVersion : 0;
      if (presented !== user.tokenVersion) {
        throw new UnauthorizedException('Session invalide ou expirée.');
      }
      return { id: user.id, email: user.email, role: user.role as UserRole, tokenVersion: user.tokenVersion };
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