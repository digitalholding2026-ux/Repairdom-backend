import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { DisputesService } from '../disputes/disputes.service.js';
import { ReviewDisputeDto } from '../disputes/dto/review-dispute.dto.js';
import { UpdateAdminDemandeStatusDto } from './dto/update-admin-demande-status.dto.js';
import { CreateB2BClientDto } from './dto/create-b2b-client.dto.js';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly disputes: DisputesService,
  ) {}

  /* Indicateurs globaux du tableau de bord admin (cockpit opérateur).
   * Lecture seule, protégée par @Roles('ADMIN') via le contrôleur parent. */
  @Get('dashboard/stats')
  getDashboardStats() {
    return this.adminService.getDashboardStats();
  }

  /* Supervision globale des demandes (liste paginée, filtre par statut).
   * Alimente la page "Demandes" du cockpit admin. */
  @Get('demandes')
  listAdminDemandes(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.adminService.listAdminDemandes({
      status: status?.trim() || undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('demandes/reference/:reference')
  getDemandeByReference(@Param('reference') reference: string) {
    return this.adminService.getDemandeByReference(reference);
  }

  /* Confirme le rendez-vous d'une demande (workflow WhatsApp, M2).
   * Pour le SMARTPHONE, l'escrow doit être payé au préalable. */
  @Patch('demandes/:id/confirm')
  confirmDemande(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.adminService.confirmDemande(id, user.id);
  }

  /* Marque une demande comme « client absent » (no-show) :
   * confirmationStatus = CANCELLED_BY_ADMIN, isNoShow = true,
   * statut global = CANCELED. */
  @Patch('demandes/:id/no-show')
  noShowDemande(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.adminService.noShowDemande(id, user.id);
  }

  /* Met à jour le statut d'une demande (workflow V2 admin) :
   * RECEIVED → IN_PROGRESS → COMPLETED, ou CANCELLED depuis RECEIVED/IN_PROGRESS.
   * Enregistre un événement DemandeEvent à chaque changement. */
  @Patch('demandes/:id/status')
  updateDemandeStatus(@Param('id') id: string, @Body() dto: UpdateAdminDemandeStatusDto, @CurrentUser() user: RequestUser) {
    return this.adminService.updateDemandeStatus(id, dto.status, user.id);
  }

  @Get('users/clients')
  searchClients(@Query('q') q?: string) {
    return this.adminService.searchClientUsers(q ?? '');
  }

  /* Crée un compte B2B (mot de passe aléatoire + proCode unique générés).
   * Les identifiants sont renvoyés à l'admin pour communication au client. */
  @Post('clients/b2b')
  createB2BClient(@Body() dto: CreateB2BClientDto) {
    return this.adminService.createB2BClient({
      email: dto.email,
      firstName: dto.firstName,
      lastName: dto.lastName,
      companyName: dto.companyName,
      phone: dto.phone,
    });
  }

  /* Gestion des comptes : détail (dépendances) + suppression administrative
   * (physique si aucune donnée liée, désactivation logique sinon). Le
   * frontend affiche une confirmation explicite ; le backend applique ses
   * propres garde-fous (jamais ADMIN, jamais soi-même). */
  @Get('users/:id')
  getUserAccount(@Param('id') id: string) {
    return this.adminService.getUserAccount(id);
  }

  @Delete('users/:id')
  deleteUserAccount(@Param('id') id: string, @CurrentUser() user: RequestUser) {
    return this.adminService.deleteUserAccount(user.id, id);
  }

  /* Litiges post-intervention (ADMIN uniquement) : liste paginée,
   * détail avec mission + parties, décision motivée. RESOLVED libère le
   * hold (fonds rendus, sans règlement) ; REJECTED rouvre la confirmation.
   * Historique immuable, jamais supprimé, jamais auto-clôturé. */
  @Get('disputes')
  listDisputes(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.disputes.listForAdmin({
      status: status?.trim() || undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('disputes/:id')
  getDispute(@Param('id') id: string) {
    return this.disputes.getForAdmin(id);
  }

  @Patch('disputes/:id/review')
  reviewDispute(@Param('id') id: string, @CurrentUser() user: RequestUser, @Body() dto: ReviewDisputeDto) {
    return this.disputes.reviewDispute(user.id, id, dto);
  }
}
