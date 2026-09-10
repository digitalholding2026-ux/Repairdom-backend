import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { DemandesService } from './demandes.service.js';
import { JwtAuthGuard } from './../auth/jwt-auth.guard.js';
import { RolesGuard } from './../auth/roles.guard.js';
import { Roles } from './../auth/roles.decorator.js';
import { CurrentUser } from './../auth/current-user.decorator.js';
import type { RequestUser } from './../auth/auth.types.js';
import { CreateDemandeDto } from './dto/create-demande.dto.js';
import { UpdateDemandeStatusDto } from './dto/update-demande-status.dto.js';

@Controller('demandes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT')
export class DemandesController {
  constructor(private readonly demandesService: DemandesService) {}

  @Post()
  create(@CurrentUser() user: RequestUser, @Body() dto: CreateDemandeDto) {
    return this.demandesService.create(user.id, dto);
  }

  @Get()
  list(@CurrentUser() user: RequestUser) {
    return this.demandesService.listForClient(user.id);
  }

  @Get('my/history')
  listHistory(@CurrentUser() user: RequestUser) {
    return this.demandesService.listForClientHistory(user.id);
  }

  @Get(':id')
  findOne(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.demandesService.findForClient(user.id, id);
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  updateStatus(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: UpdateDemandeStatusDto) {
    return this.demandesService.updateStatus(user.id, id, dto);
  }
}