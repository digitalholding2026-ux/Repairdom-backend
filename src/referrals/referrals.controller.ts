import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { ReferralsService } from './referrals.service.js';

/**
 * Chantier 4B — Parrainage client.
 *
 * READ + une seule écriture : les DEUX endpoints sont strictement scopés au
 * client connecté. Le `userId` n'est JAMAIS accepté depuis le frontend — il
 * est toujours déduit du JWT, comme pour le reste des finances.
 *
 * `POST /client/referrals/code` crée le code au besoin : afficher la page
 * `/client/parrainage` doit fonctionner pour un client qui n'en a jamais
 * demandé. C'est une ÉCRITURE, donc `201` — mais idempotente dans les faits
 * (un second appel renvoie le code existant).
 */
@Controller('client/referrals')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT')
export class ReferralsController {
  constructor(private readonly referrals: ReferralsService) {}

  /** Code, lien de partage, progression et liste des filleuls. */
  @Get('me')
  getMine(@CurrentUser() user: RequestUser) {
    return this.referrals.getMyReferrals(user.id);
  }

  /** Génère le code personnel s'il n'existe pas encore. */
  @Post('code')
  @HttpCode(HttpStatus.OK)
  async ensureCode(@CurrentUser() user: RequestUser) {
    const code = await this.referrals.getOrCreateMyCode(user.id);
    if (!code) throw new NotFoundException('Code de parrainage indisponible.');
    return { code };
  }
}