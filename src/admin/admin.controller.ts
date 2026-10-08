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
import { UpdateKycStatusDto } from './dto/update-kyc-status.dto.js';
import { SendTechnicianMessageDto } from './dto/send-technician-message.dto.js';
import { DisputesService } from '../disputes/disputes.service.js';
import { ReviewDisputeDto } from '../disputes/dto/review-dispute.dto.js';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly disputes: DisputesService,
  ) {}

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

  @Get('users/technicians')
  searchTechnicians(@Query('q') q?: string) {
    return this.adminService.searchTechnicianUsers(q ?? '');
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

  /* Message direct ADMIN → TECHNICIEN, destinataire résolu par email côté
   * backend. Stocké comme notification (type ADMIN_MESSAGE) visible dans
   * l'espace technicien existant. */
  @Post('messages/technician')
  sendTechnicianMessage(
    @Body() dto: SendTechnicianMessageDto,
    @CurrentUser() user: RequestUser,
  ) {
    return this.adminService.sendTechnicianMessage(user.id, dto.email, dto.message);
  }

  /* ── Chantier 4-FONDATIONS-A — nouveau barème de commission ──
   * Déclenchement MANUEL et UNIQUE par l'admin, jamais automatique. Prévu
   * pour être déclenché une fois le nouveau barème affiché côté technicien
   * (l'e-mail renvoie vers `/technicien/demandes`). Réponse : `{ sent, failed,
   * total, failedChannels }`. Un échec par technicien ou par canal n'interrompt
   * jamais la campagne. */
  @Post('notify-technicians/fee-change')
  notifyTechniciansFeeChange() {
    return this.adminService.notifyTechniciansFeeChange();
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
