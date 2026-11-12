import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, NotFoundException, Param, Patch, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
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
import { TrackSearchDto } from './dto/track-search.dto.js';
import { DisputesService } from '../disputes/disputes.service.js';
import { OpenDisputeDto } from '../disputes/dto/open-dispute.dto.js';
import { PrismaService } from '../prisma/prisma.service.js';

@Controller('demandes')
export class DemandesController {
  constructor(
    private readonly demandesService: DemandesService,
    private readonly mediaService: DemandeMediaService,
    private readonly disputesService: DisputesService,
    private readonly prisma: PrismaService,
  ) {}

  /* Dépôt multimédia — upload réel AVANT création (aucune ligne créée ;
   * le chemin est lié en transaction à `POST /demandes`). 25 Mo max,
   * formats image/vidéo/audio validés côté service. */
  @Post('medias/upload')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT')
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
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT')
  deleteUploadedMedia(@CurrentUser() user: RequestUser, @Body('storagePath') storagePath?: string) {
    if (!storagePath) throw new BadRequestException('Chemin de fichier manquant.');
    return this.mediaService.deleteUploadedMedia(user.id, storagePath);
  }

  /* Lecture d'une pièce jointe (URL signée éphémère, client propriétaire
   * uniquement — 404 sinon). Lazy côté UI : jamais préchargée en masse. */
  @Get(':id/medias/:mediaId/file')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT')
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
  create(@CurrentUser() user: RequestUser | null, @Body() dto: CreateDemandeDto) {
    return this.demandesService.create(user?.id ?? null, dto);
  }

  @Get()
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT')
  list(@CurrentUser() user: RequestUser) {
    return this.demandesService.listForClient(user.id);
  }

  @Get('my/history')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT')
  listHistory(@CurrentUser() user: RequestUser) {
    return this.demandesService.listForClientHistory(user.id);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT')
  findOne(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.demandesService.findForClient(user.id, id);
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT')
  updateStatus(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: UpdateDemandeStatusDto) {
    return this.demandesService.updateStatus(user.id, id, dto);
  }

  /* Litige post-intervention — ouverture client (mission COMPLETED,
   * un seul litige par mission, jamais supprimé). Bloque la confirmation
   * et donc le règlement tant qu'il n'est pas tranché. */
  @Post(':id/dispute')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT')
  openDispute(@CurrentUser() user: RequestUser, @Param('id') id: string, @Body() dto: OpenDisputeDto) {
    return this.disputesService.openDispute(user.id, id, dto);
  }

  /* Lecture du litige de la mission (client propriétaire, null si aucun). */
  @Get(':id/dispute')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT')
  getDispute(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.disputesService.getForParty(user, id);
  }

  /* Suivi public anonyme par référence lisible (ex: FRP-023) :
   * Renvoie le statut, l'historique des événements et les infos de base.
   * Aucune authentification requise. */
  @Get('tracking/reference/:reference')
  async trackByReference(@Param('reference') reference: string) {
    return this.demandesService.findByReference(reference);
  }

  /* Suivi public anonyme par token (client invité, pas de compte) :
   * Renvoie le statut, l'historique des événements et les infos de base.
   * Aucune authentification requise. */
  @Get('tracking/:trackingToken')
  async trackByToken(@Param('trackingToken') token: string) {
    const demande = await this.prisma.demande.findUnique({
      where: { trackingToken: token },
      include: {
        domain: { select: { name: true } },
        brand: { select: { name: true } },
        model: { select: { name: true } },
        problem: { select: { name: true } },
        events: {
          orderBy: { createdAt: 'asc' },
          take: 200,
          select: { type: true, createdAt: true },
        },
      },
    });

    if (!demande) {
      throw new NotFoundException('Aucune demande ne correspond à ce lien de suivi.');
    }

    return {
      reference: demande.reference,
      status: demande.status,
      category: demande.domain ? demande.domain.name : demande.category,
      model: demande.model ? demande.model.name : null,
      problem: demande.problem ? demande.problem.name : null,
      price: demande.finalAmount ?? null,
      createdAt: demande.createdAt.toISOString(),
      address: demande.address ?? null,
      city: demande.city,
      contactPhone: demande.contactPhone ?? null,
      timeline: demande.events.map((e) => ({
        type: e.type,
        label: e.type,
        date: e.createdAt.toISOString(),
      })),
    };
  }

  /* Recherche publique des demandes par numéro de téléphone (client invité,
   * pas de compte). Renvoie la liste des demandes liées à ce numéro,
   * triées par date décroissante. Aucune authentification requise. */
  @Post('tracking/search')
  async searchByPhone(@Body() dto: TrackSearchDto) {
    return this.demandesService.searchByPhone(dto);
  }
}