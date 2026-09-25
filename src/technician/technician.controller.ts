import {
  Controller,
  Get,
  Patch,
  Post,
  Put,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  BadRequestException,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { TechnicianService } from './technician.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { UpdateTechnicianProfileDto } from './dto/update-technician-profile.dto.js';
import { UpdateTechnicianLocationDto } from './dto/update-location.dto.js';
import { UpdateCoverageDto } from './dto/update-coverage.dto.js';
import { TechnicianUpdateStatusDto } from './dto/update-status.dto.js';
import { MAX_AVATAR_SIZE, isAllowedAvatarMimetype, type UploadedAvatarFile } from './avatar-file.js';
import {
  MAX_KYC_DOCUMENT_SIZE,
  isAllowedKycMimetype,
  type UploadedKycFile,
} from './kyc-file.js';

@Controller('technician')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('TECHNICIAN')
export class TechnicianController {
  constructor(private readonly technicianService: TechnicianService) {}

  @Get('profile')
  getProfile(@CurrentUser() user: RequestUser) {
    return this.technicianService.getProfile(user.id);
  }

  @Patch('profile')
  updateProfile(@CurrentUser() user: RequestUser, @Body() dto: UpdateTechnicianProfileDto) {
    return this.technicianService.updateProfile(user.id, dto);
  }

  /* GPS V1 — dernière position connue (transmission explicite et ponctuelle,
   * jamais de tracking). Route strictement personnelle : le technicien ne
   * touche que sa propre position (JWT, aucun identifiant de tiers). */
  @Patch('location')
  @HttpCode(HttpStatus.OK)
  updateLocation(@CurrentUser() user: RequestUser, @Body() dto: UpdateTechnicianLocationDto) {
    return this.technicianService.updateLocation(user.id, dto.latitude, dto.longitude);
  }

  /* Sprint 8.8.2 — couverture géographique personnelle (zones de la ville de
   * référence). Routes strictement personnelles : aucun paramètre
   * d'identifiant, le technicien connecté ne touche que sa couverture. */
  @Get('coverage')
  getCoverage(@CurrentUser() user: RequestUser) {
    return this.technicianService.getCoverage(user.id);
  }

  @Put('coverage')
  @HttpCode(HttpStatus.OK)
  updateCoverage(@CurrentUser() user: RequestUser, @Body() dto: UpdateCoverageDto) {
    return this.technicianService.setCoverage(user.id, dto.zoneIds);
  }

  @Post('profile/avatar')
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
    return this.technicianService.uploadAvatar(user.id, file);
  }

  @Post('kyc/documents')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: MAX_KYC_DOCUMENT_SIZE },
      fileFilter(_request, file, callback) {
        if (!isAllowedKycMimetype(file.mimetype)) {
          callback(
            new BadRequestException('Format non supporté. Formats acceptés : PDF, JPG, PNG, WEBP.'),
            false,
          );
          return;
        }
        callback(null, true);
      },
    }),
  )
  submitKycDocument(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file?: UploadedKycFile,
    @Body('type') type?: string,
  ) {
    return this.technicianService.submitKycDocument(user.id, file, type ?? '');
  }

  @Get('kyc')
  listKycDocuments(@CurrentUser() user: RequestUser) {
    return this.technicianService.listKycDocuments(user.id);
  }

  @Delete('kyc/documents/:id')
  @HttpCode(HttpStatus.OK)
  deleteKycDocument(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.technicianService.deleteKycDocument(user.id, id);
  }

  @Get('available')
  listAvailable(@CurrentUser() user: RequestUser) {
    return this.technicianService.listAvailable(user.id);
  }

  @Get('my-demandes')
  listMine(@CurrentUser() user: RequestUser) {
    return this.technicianService.listMine(user.id);
  }

  @Get('my-demandes/history')
  listMineHistory(@CurrentUser() user: RequestUser) {
    return this.technicianService.listMineHistory(user.id);
  }

  @Get('demandes/:id')
  getDemandeDetail(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.technicianService.getDemandeDetail(user.id, id);
  }

  @Post('demandes/:id/accept')
  @HttpCode(HttpStatus.OK)
  acceptDemande(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.technicianService.acceptDemande(user.id, id);
  }

  @Patch('demandes/:id/status')
  updateStatus(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: TechnicianUpdateStatusDto) {
    return this.technicianService.updateStatus(user.id, id, dto);
  }
}