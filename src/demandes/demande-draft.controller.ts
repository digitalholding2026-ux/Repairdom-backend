import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { DemandeDraftService, DRAFT_RETENTION_DAYS } from './demande-draft.service.js';
import { DraftThrottle, DraftThrottleGuard } from './demande-draft-throttle.guard.js';
import { CreateDemandeDraftDto } from './dto/create-demande-draft.dto.js';
import { UpdateDemandeDraftDto } from './dto/update-demande-draft.dto.js';
import { ConvertDemandeDraftDto } from './dto/convert-demande-draft.dto.js';

/* Chantier D1 — brouillon de demande, PARCOURS NON AUTHENTIFIÉ.
 *
 * ⚠️ PAS DE GUARD AU NIVEAU DE LA CLASSE (volontaire) : les trois routes de
 * brouillon doivent être atteignables par un visiteur qui n'a pas de compte.
 * Les guards sont posés UNIQUEMENT sur la méthode `convert`, qui crée une
 * vraie `Demande` rattachée à un compte.
 *
 * Conséquence à connaître : ajouter `@UseGuards` sur cette classe casserait
 * immédiatement le parcours non authentifié. Le test d'assemblage
 * `demande-draft.module.spec.ts` vérifie les deux comportements (200 anonyme
 * sur le brouillon, 401 anonyme sur la conversion).
 *
 * Le `token` est un lien magique : il est la SEULE autorisation d'accès au
 * brouillon. Aucun journal applicatif ne le mentionne. */
@Controller('demandes/drafts')
export class DemandeDraftController {
  constructor(private readonly draftService: DemandeDraftService) {}

  /* Création — 10 / heure / IP (seule route qui écrit : c'est la seule
   * depuis laquelle la table peut grossir). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(DraftThrottleGuard)
  @DraftThrottle(10)
  async create(@Body() dto: CreateDemandeDraftDto) {
    const { token, expiresAt } = await this.draftService.create(dto);
    /* `retentionDays` explicite : le client n'a pas à convertir un timestamp
     * pour savoir s'il a le temps de finir sa description. */
    return { token, expiresAt, retentionDays: DRAFT_RETENTION_DAYS };
  }

  /* Mise à jour partielle — 30 / heure / IP. */
  @Patch(':token')
  @UseGuards(DraftThrottleGuard)
  @DraftThrottle(30)
  async update(@Param('token') token: string, @Body() dto: UpdateDemandeDraftDto) {
    return this.draftService.update(token, dto);
  }

  /* Reprise après fermeture d'onglet — 60 / heure / IP. */
  @Get(':token')
  @UseGuards(DraftThrottleGuard)
  @DraftThrottle(60)
  async getByToken(@Param('token') token: string) {
    return this.draftService.getByToken(token);
  }

  /* Conversion — la SEULE route protégée. Le compte doit exister, être actif
   * et porter le rôle CLIENT : c'est ici que la `Demande` naît, avec son
   * `clientId`, son événement `CREATED` et le dispatch vague 1 (déclenché par
   * `DemandesService.create`, appelé sans interception). */
  @Post(':token/convert')
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT')
  async convert(
    @Param('token') token: string,
    @CurrentUser() user: RequestUser,
    @Body() dto: ConvertDemandeDraftDto,
  ) {
    return this.draftService.convert(token, user.id, dto.medias ?? []);
  }
}