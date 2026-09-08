import { Controller, Get, Patch, Post, Param, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { TechnicianService } from './technician.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { UpdateTechnicianProfileDto } from './dto/update-technician-profile.dto.js';
import { TechnicianUpdateStatusDto } from './dto/update-status.dto.js';

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

  @Get('available')
  listAvailable(@CurrentUser() user: RequestUser) {
    return this.technicianService.listAvailable(user.id);
  }

  @Get('my-demandes')
  listMine(@CurrentUser() user: RequestUser) {
    return this.technicianService.listMine(user.id);
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