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
import { ReviewAiWarningDto } from './dto/review-ai-warning.dto.js';
import { ReviewConversationFlagDto } from './dto/review-conversation-flag.dto.js';
import { AiWarningService } from '../ai/ai-warning.service.js';
import { AiConversationWatchService } from '../ai/ai-conversation-watch.service.js';
import { AiAdminService } from '../ai/ai-admin.service.js';
import { AiClassificationService } from '../ai/ai-classification.service.js';
import { AiDiagnosisMatchService } from '../ai/ai-diagnosis-match.service.js';
import { AiPricingCheckService } from '../ai/ai-pricing-check.service.js';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(
    private readonly adminService: AdminService,
    private readonly warnings: AiWarningService,
    private readonly conversationWatch: AiConversationWatchService,
    private readonly aiAdmin: AiAdminService,
    private readonly classifications: AiClassificationService,
    private readonly diagnosisMatches: AiDiagnosisMatchService,
    private readonly pricingChecks: AiPricingCheckService,
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

  /* IA-7 — surveillance tarifaire (lecture + revue humaine, jamais de
   * sanction automatique). Données : avertissements, technicien, demande,
   * quote, diagnostic, prix, barème snapshot, justification, statut
   * effectif, niveau de surveillance, dates, historique. */
  @Get('ai-warnings')
  listAiWarnings(
    @Query('technicianId') technicianId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.warnings.getWarningsForAdmin({
      technicianId: technicianId?.trim() || undefined,
      status: status?.trim() || undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('ai-warnings/technician/:id/level')
  getTechnicianSurveillanceLevel(@Param('id') id: string) {
    return this.warnings.getSurveillanceLevel(id).then((level) => ({
      technicianId: id,
      surveillanceLevel: level,
      humanReviewRequired: level >= 3,
    }));
  }

  @Post('ai-warnings/:id/review')
  reviewAiWarning(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: ReviewAiWarningDto,
  ) {
    return this.warnings.reviewWarning(user.id, id, dto.reviewNote);
  }

  /* IA-8 — surveillance conversationnelle (signaux OPEN + revue humaine,
   * jamais de sanction automatique, jamais visible client/technicien).
   * Données : catégorie, sévérité, confiance, message, conversation,
   * demande, auteurs, dates, statut, historique de revue. */
  @Get('conversation-flags')
  listConversationFlags(
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('severity') severity?: string,
    @Query('demandeId') demandeId?: string,
    @Query('senderId') senderId?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.conversationWatch.getFlagsForAdmin({
      status: status?.trim() || undefined,
      category: category?.trim() || undefined,
      severity: severity?.trim() || undefined,
      demandeId: demandeId?.trim() || undefined,
      senderId: senderId?.trim() || undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Post('conversation-flags/:id/review')
  reviewConversationFlag(
    @Param('id') id: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: ReviewConversationFlagDto,
  ) {
    return this.conversationWatch.reviewFlag(user.id, id, dto.decision, dto.reviewNote);
  }

  /* IA-9 — dashboard IA admin (visualisation + revue humaine, jamais de
   * décision automatique : voir, filtrer, examiner — l'humain décide). */

  @Get('ai/overview')
  getAiOverview() {
    return this.aiAdmin.getOverview();
  }

  @Get('ai/classifications')
  listAiClassifications(
    @Query('classification') classification?: string,
    @Query('domainId') domainId?: string,
    @Query('demandeId') demandeId?: string,
    @Query('since') since?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.classifications.listForAdmin({
      classification: classification?.trim() || undefined,
      domainId: domainId?.trim() || undefined,
      demandeId: demandeId?.trim() || undefined,
      since: since?.trim() || undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('ai/matches')
  listAiMatches(
    @Query('classification') classification?: string,
    @Query('demandeId') demandeId?: string,
    @Query('since') since?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.diagnosisMatches.listForAdmin({
      classification: classification?.trim() || undefined,
      demandeId: demandeId?.trim() || undefined,
      since: since?.trim() || undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }

  @Get('ai/pricing-checks')
  listAiPricingChecks(
    @Query('result') result?: string,
    @Query('demandeId') demandeId?: string,
    @Query('technicianId') technicianId?: string,
    @Query('since') since?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.pricingChecks.listForAdmin({
      result: result?.trim() || undefined,
      demandeId: demandeId?.trim() || undefined,
      technicianId: technicianId?.trim() || undefined,
      since: since?.trim() || undefined,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
  }
}