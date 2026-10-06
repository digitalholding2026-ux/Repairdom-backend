import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Request, Response } from 'express';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import type { RequestUser } from './auth.types.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { ResendVerificationDto } from './dto/resend-verification.dto.js';
import { ForgotPasswordDto } from './dto/forgot-password.dto.js';
import { ResetPasswordDto } from './dto/reset-password.dto.js';
import { UpdateMeDto } from './dto/update-me.dto.js';
import { MAX_AVATAR_SIZE, isAllowedAvatarMimetype, type UploadedAvatarFile } from '../technician/avatar-file.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const user = await this.authService.register(dto);
    /* Chantier D2.5 — la session est posée SYSTÉMATIQUEMENT, y compris pour
     * un CLIENT dont l'e-mail n'est pas encore vérifié.
     *
     * POURQUOI CE CHANGEMENT (le conditionnel précédent était `if
     * (user.emailVerified)`) : le cookie est une identité de session, pas un
     * badge de vérification. Tant qu'il était conditionnel, le tunnel public
     * « demande d'abord, inscription à la fin » était mort-né : après
     * inscription, le visiteur n'avait aucun cookie, donc
     * `POST /demandes/drafts/:token/convert` répondait 401 et la demande
     * être envoyée.
     *
     * CE QUI N'A PAS CHANGÉ : la vérification d'e-mail reste obligatoire pour
     * ACCÉDER au dashboard. `guard-decision.ts` (frontend) redirige un CLIENT
     * `emailVerified === false` vers `/client/verification`, quelle que soit
     * la présence du cookie. Le cookie donne donc l'identité, la vérification
     * donne l'accès — les deux contrôles restent séparés. */
    this.authService.setAuthCookie(res, this.authService.signToken(user));
    return { user, mode: 'real' };
  }

  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  async verifyEmail(@Body() dto: VerifyEmailDto, @Res({ passthrough: true }) res: Response) {
    const user = await this.authService.verifyEmail(dto.token);
    this.authService.setAuthCookie(res, this.authService.signToken(user));
    return { user, mode: 'real' };
  }

  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  async resendVerification(@Body() dto: ResendVerificationDto) {
    return this.authService.resendVerification(dto.email);
  }

  /* Reset password — routes publiques (aucune session requise) :
   * - forgot-password répond TOUJOURS 200 (anti-énumération) ;
   * - validate permet au frontend d'afficher le formulaire ou l'erreur ;
   * - reset-password consomme le token en usage unique et invalide les
   *   sessions existantes (tokenVersion). */
  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    const ip = req.ip ?? undefined;
    return this.authService.requestPasswordReset(dto.email, ip);
  }

  @Get('reset-password/:token/validate')
  async validateResetToken(@Param('token') token: string) {
    return this.authService.validateResetToken(token);
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  async resetPassword(@Body() dto: ResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.newPassword);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const user = await this.authService.login(dto);
    this.authService.setAuthCookie(res, this.authService.signToken(user));
    return { user, mode: 'real' };
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: RequestUser) {
    return this.authService.me(user.id);
  }

  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  async updateMe(@CurrentUser() user: RequestUser, @Body() dto: UpdateMeDto) {
    return this.authService.updateMe(user.id, dto);
  }

  @Post('me/avatar')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: MAX_AVATAR_SIZE },
      fileFilter(_request, file, callback) {
        if (!isAllowedAvatarMimetype(file.mimetype)) {
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
  uploadAvatar(@CurrentUser() user: RequestUser, @UploadedFile() file?: UploadedAvatarFile) {
    return this.authService.uploadAvatar(user.id, file);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  logout(@Res({ passthrough: true }) res: Response) {
    this.authService.clearAuthCookie(res);
    return { success: true, mode: 'real' };
  }
}