import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Query, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CollaborationService } from './collaboration.service.js';
import { DemandeMediaService, DEMANDE_MEDIA_MAX_BYTES } from '../demandes/demande-media.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { CreateDiagnosticDto } from './dto/create-diagnostic.dto.js';
import { CreateQuoteDto } from './dto/create-quote.dto.js';
import { SelectCatalogDiagnosticDto } from './dto/select-catalog-diagnostic.dto.js';
import { DisputesService } from '../disputes/disputes.service.js';

@Controller('demandes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT', 'TECHNICIAN')
export class CollaborationController {
  constructor(
    private readonly collaborationService: CollaborationService,
    private readonly mediaService: DemandeMediaService,
    private readonly disputesService: DisputesService,
  ) {}

  @Get(':demandeId/messages')
  listMessages(@CurrentUser() user: RequestUser, @Param('demandeId') demandeId: string) {
    return this.collaborationService.listMessages(user, demandeId);
  }

  @Post(':demandeId/messages')
  sendMessage(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.collaborationService.sendMessage(user, demandeId, dto);
  }

  @Get(':demandeId/diagnostics')
  listDiagnostics(@CurrentUser() user: RequestUser, @Param('demandeId') demandeId: string) {
    return this.collaborationService.listDiagnostics(user, demandeId);
  }

  @Post(':demandeId/diagnostic')
  createDiagnostic(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Body() dto: CreateDiagnosticDto,
  ) {
    return this.collaborationService.createDiagnostic(user, demandeId, dto);
  }

  /* Note vocale du diagnostic libre (TECHNICIAN assigné) : upload
   * réel AVANT création, lié en transaction (aucune ligne orpheline).
   * 25 Mo max, formats audio validés côté service. */
  @Post(':demandeId/diagnostics/audio/upload')
  @Roles('TECHNICIAN')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: DEMANDE_MEDIA_MAX_BYTES },
    }),
  )
  uploadDiagnosticAudio(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined,
  ) {
    return this.mediaService.uploadDiagnosticAudio(user.id, file);
  }

  @Delete(':demandeId/diagnostics/audio/upload')
  @Roles('TECHNICIAN')
  @HttpCode(HttpStatus.OK)
  deleteDiagnosticAudio(
    @CurrentUser() user: RequestUser,
    @Body('storagePath') storagePath?: string,
  ) {
    if (!storagePath) {
      throw new BadRequestException('Chemin de fichier manquant.');
    }
    return this.mediaService.deleteDiagnosticAudio(user.id, storagePath);
  }

  /* Écoute (URL signée éphémère) : technicien assigné ou client
   * propriétaire, 404 sinon. Lazy côté UI. */
  @Get(':demandeId/diagnostics/:diagnosticId/audio')
  diagnosticAudioUrl(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Param('diagnosticId') diagnosticId: string,
  ) {
    return this.mediaService
      .getDiagnosticAudioUrl({ userId: user.id, role: user.role }, demandeId, diagnosticId)
      .then((url) => ({ url }));
  }

  @Get(':demandeId/catalog/suggestions')
  @Roles('TECHNICIAN')
  suggestDiagnostics(@CurrentUser() user: RequestUser, @Param('demandeId') demandeId: string) {
    return this.collaborationService.suggestDiagnostics(user, demandeId);
  }

  @Post(':demandeId/diagnostic/select')
  @Roles('TECHNICIAN')
  selectCatalogDiagnostic(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Body() dto: SelectCatalogDiagnosticDto,
  ) {
    return this.collaborationService.selectCatalogDiagnostic(user, demandeId, dto);
  }

  @Post(':demandeId/quotes/:quoteId/negotiate')
  @Roles('CLIENT')
  @HttpCode(HttpStatus.OK)
  requestNegotiation(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Param('quoteId') quoteId: string,
  ) {
    return this.collaborationService.requestNegotiation(user, demandeId, quoteId);
  }

  @Get(':demandeId/quotes')
  listQuotes(@CurrentUser() user: RequestUser, @Param('demandeId') demandeId: string) {
    return this.collaborationService.listQuotes(user, demandeId);
  }

  @Post(':demandeId/quotes')
  createQuote(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Body() dto: CreateQuoteDto,
  ) {
    return this.collaborationService.createQuote(user, demandeId, dto);
  }

  @Post(':demandeId/quotes/:quoteId/accept')
  @HttpCode(HttpStatus.OK)
  acceptQuote(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Param('quoteId') quoteId: string,
  ) {
    return this.collaborationService.respondToQuote(user, demandeId, quoteId, 'accept');
  }

  @Post(':demandeId/quotes/:quoteId/reject')
  @HttpCode(HttpStatus.OK)
  rejectQuote(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Param('quoteId') quoteId: string,
  ) {
    return this.collaborationService.respondToQuote(user, demandeId, quoteId, 'reject');
  }

  @Get('chronologies/mine')
  listChronologies(@CurrentUser() user: RequestUser, @Query('scope') scope: string) {
    return this.collaborationService.listChronologies(user, scope);
  }

  @Get(':demandeId/events')
  listEvents(@CurrentUser() user: RequestUser, @Param('demandeId') demandeId: string) {
    return this.collaborationService.listEvents(user, demandeId);
  }

  @Get(':demandeId/summary')
  summary(@CurrentUser() user: RequestUser, @Param('demandeId') demandeId: string) {
    return this.collaborationService.summary(user, demandeId);
  }

  /* Visibilité du litige pour les deux parties (client propriétaire ou
   * technicien assigné, 404 sinon — jamais de conversion auto, la prose
   * éventuelle n'existe pas ici : seul le contrat Dispute est renvoyé). */
  @Get(':demandeId/dispute')
  getDispute(@CurrentUser() user: RequestUser, @Param('demandeId') demandeId: string) {
    return this.disputesService.getForParty(user, demandeId);
  }
}