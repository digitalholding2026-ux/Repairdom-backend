import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { RewardsService } from './rewards.service.js';
import { REWARD_TIER_NAMES } from './rewards.config.js';

/**
 * Chantier #4A — Programme de récompenses, espace CLIENT.
 *
 * Monté sous `/api/client/rewards` : le préfixe `client` sépare
 * l'espace client des routes `/demandes` (créées par le client, pas pour lui).
 * Les routes sont en français comme les autres espaces authentifiés
 * (`/client/recompenses`), l'API métier restant en anglais — voir le
 * `ARCHITECTURE.md` frontend.
 *
 * Le garde `JwtAuthGuard` + `RolesGuard` + `@Roles('CLIENT')` est appliqué sur
 * le contrôleur entier : aucun accès anonyme ou technicien.
 */
@Controller('client/rewards')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT')
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  /** Progression complète : compteur, niveau, paliers, prochain palier. */
  @Get()
  getProgress(@CurrentUser() user: RequestUser) {
    return this.rewards.getProgress(user.id);
  }

  /**
   * Enregistre la demande d'usage d'une récompense.
   *
   * Le palier est validé en amont contre la liste des 4 paliers connus : un
   * palier hors liste est rejeté 400 SANS appel au service (pas de lecture en
   * base pour une entrée manifestement invalide). Le service revalide ensuite
   * « atteint » et « pas déjà demandé ».
   */
  @Post(':tier/claim')
  @HttpCode(HttpStatus.OK)
  claimTier(@CurrentUser() user: RequestUser, @Param('tier') tier: string) {
    const normalized = tier.trim().toUpperCase();
    if (!REWARD_TIER_NAMES.includes(normalized as (typeof REWARD_TIER_NAMES)[number])) {
      throw new BadRequestException(
        `Palier inconnu. Valeurs acceptées : ${REWARD_TIER_NAMES.join(', ')}.`,
      );
    }
    return this.rewards.claimTier(user.id, normalized);
  }
}
