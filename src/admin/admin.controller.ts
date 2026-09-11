import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { UpdateKycStatusDto } from './dto/update-kyc-status.dto.js';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('kyc')
  listKycFolders(@Query('status') status?: string) {
    return this.adminService.listKycFolders(status);
  }

  @Get('kyc/:technicianId')
  getKycFolder(@Param('technicianId') technicianId: string) {
    return this.adminService.getKycFolder(technicianId);
  }

  @Get('kyc/:technicianId/documents/:documentId/url')
  getKycDocumentUrl(
    @Param('technicianId') technicianId: string,
    @Param('documentId') documentId: string,
  ) {
    return this.adminService.getKycDocumentUrl(technicianId, documentId);
  }

  @Get('demandes/reference/:reference')
  getDemandeByReference(@Param('reference') reference: string) {
    return this.adminService.getDemandeByReference(reference);
  }

  @Patch('kyc/:technicianId/status')
  updateKycStatus(
    @Param('technicianId') technicianId: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: UpdateKycStatusDto,
  ) {
    return this.adminService.updateKycStatus(technicianId, user.id, dto);
  }

  @Get('users/clients')
  searchClients(@Query('q') q?: string) {
    return this.adminService.searchClientUsers(q ?? '');
  }
}