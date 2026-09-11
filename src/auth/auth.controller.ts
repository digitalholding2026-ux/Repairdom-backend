import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { AuthService } from './auth.service.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { CurrentUser } from './current-user.decorator.js';
import type { RequestUser } from './auth.types.js';
import { RegisterDto } from './dto/register.dto.js';
import { LoginDto } from './dto/login.dto.js';
import { VerifyEmailDto } from './dto/verify-email.dto.js';
import { ResendVerificationDto } from './dto/resend-verification.dto.js';
import { UpdateMeDto } from './dto/update-me.dto.js';
import { MAX_AVATAR_SIZE, isAllowedAvatarMimetype, type UploadedAvatarFile } from '../technician/avatar-file.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    const user = await this.authService.register(dto);
    // Comptes CLIENT : pas de session tant que l'email n'est pas vérifié.
    // L'utilisateur est redirigé vers /client/verification puis se connecte
    // après confirmation.
    if (user.emailVerified) {
      this.authService.setAuthCookie(res, this.authService.signToken(user));
    }
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