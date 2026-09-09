import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { TechnicianService } from './technician.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';

@Controller('technicians')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT', 'TECHNICIAN')
export class TechniciansPublicController {
  constructor(private readonly technicianService: TechnicianService) {}

  @Get(':id/profile')
  getPublicProfile(@Param('id') id: string) {
    return this.technicianService.getPublicProfile(id);
  }
}