import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DemandesService } from './demandes.service.js';
import { DemandeMediaService, DEMANDE_MEDIA_MAX_BYTES } from './demande-media.service.js';
import { JwtAuthGuard } from './../auth/jwt-auth.guard.js';
import { RolesGuard } from './../auth/roles.guard.js';
import { Roles } from './../auth/roles.decorator.js';
import { CurrentUser } from './../auth/current-user.decorator.js';
import type { RequestUser } from './../auth/auth.types.js';
import { CreateDemandeDto } from './dto/create-demande.dto.js';
import { UpdateDemandeStatusDto } from './dto/update-demande-status.dto.js';
import { DisputesService } from '../disputes/disputes.service.js';
import { OpenDisputeDto } from '../disputes/dto/open-dispute.dto.js';

@Controller('demandes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT')
export class DemandesController {
  constructor(
    private readonly demandesService: DemandesService,
    private readonly mediaService: DemandeMediaService,
    private readonly disputesService: DisputesService,
  ) {}

  /* Dépôt multimédia — upload réel AVANT création (aucune ligne créée ;
   * le chemin est lié en transaction à `POST /demandes`). 25 Mo max,
   * formats image/vidéo/audio validés côté service. */
  @Post('medias/upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { files: 1, fileSize: DEMANDE_MEDIA_MAX_BYTES },
    }),
  )
  uploadMedia(
    @CurrentUser() user: RequestUser,
    @UploadedFile() file: { buffer: Buffer; mimetype: string; originalname: string; size: number } | undefined,
    @Body('kind') kind?: string,
  ) {
    return this.mediaService.uploadMedia(user.id, file, kind);
  }

  /* Nettoyage best-effort d'un upload abandonné (demande non créée). */
  @Delete('medias/upload')
  @HttpCode(HttpStatus.OK)
  deleteUploadedMedia(@CurrentUser() user: RequestUser, @Body('storagePath') storagePath?: string) {
    if (!storagePath) throw new BadRequestException('Chemin de fichier manquant.');
    return this.mediaService.deleteUploadedMedia(user.id, storagePath);
  }

  /* Lecture d'une pièce jointe (URL signée éphémère, client propriétaire
   * uniquement — 404 sinon). Lazy côté UI : jamais préchargée en masse. */
  @Get(':id/medias/:mediaId/file')
  mediaFileUrl(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Param('mediaId') mediaId: string,
  ) {
    return this.mediaService
      .getMediaFileUrl({ userId: user.id, role: user.role }, id, mediaId)
      .then((url) => ({ url }));
  }

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

  /* Litige post-intervention — ouverture client (mission COMPLETED,
   * un seul litige par mission, jamais supprimé). Bloque la confirmation
   * et donc le règlement tant qu'il n'est pas tranché. */
  @Post(':id/dispute')
  @HttpCode(HttpStatus.CREATED)
  openDispute(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: OpenDisputeDto) {
    return this.disputesService.openDispute(user.id, id, dto);
  }

  /* Lecture du litige de la mission (client propriétaire, null si aucun). */
  @Get(':id/dispute')
  getDispute(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.disputesService.getForParty(user, id);
  }
}