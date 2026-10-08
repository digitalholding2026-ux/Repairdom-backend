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
import { NATURE_TIER_NAMES } from './rewards.config.js';

/**
 * Chantier 4-FONDATIONS-C — Programme de fidélité LTV, espace CLIENT.
 *
 * Monté sous `/api/client/rewards` : le préfixe `client` sépare l'espace
 * client des routes `/demandes` (créées par le client, pas pour lui). Les
 * routes sont en français comme les autres espaces authentifiés
 * (`/client/recompenses`), l'API métier restant en anglais — voir
 * `ARCHITECTURE.md` frontend.
 *
 * Le garde `JwtAuthGuard` + `RolesGuard` + `@Roles('CLIENT')` est appliqué sur
 * le contrôleur entier : aucun accès anonyme ou technicien.
 *
 * ⚠️ ORDRE DES ROUTES — les littéraux sont déclarés AVANT `:tier/claim`.
 * NestTest les déclare dans l'ordre, donc un `:tier` déclaré plus haut
 * absorberait `credits` et `nature` comme un nom de palier. Les deux segments
 * littéraux doivent rester en tête.
 */
@Controller('client/rewards')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT')
export class RewardsController {
  constructor(private readonly rewards: RewardsService) {}

  /** Progression complète : marge cumulée, badges, crédits, nature. */
  @Get()
  getProgress(@CurrentUser() user: RequestUser) {
    return this.rewards.getProgress(user.id);
  }

  /**
   * Verse les crédits DISPONIBLES au solde du client.
   *
   * Le montant n'est jamais fourni par le frontend : c'est le backend qui le
   * déduit de `creditsEarned - creditsClaimed`. Un client ne peut donc pas
   * s'attribuer un montant arbitraire, même en forgeant la requête.
   */
  @Post('credits/claim')
  @HttpCode(HttpStatus.OK)
  claimCredits(@CurrentUser() user: RequestUser) {
    return this.rewards.claimCredits(user.id);
  }

  /**
   * Enregistre la demande de versement d'une récompense nature.
   *
   * Le palier est validé en amont contre la liste des 3 paliers connus : un
   * palier hors liste est rejeté 400 SANS appel au service (pas de lecture en
   * base pour une entrée manifestement invalide). Le service revalide ensuite
   * « atteint » et « pas déjà réclamé ».
   */
  @Post('nature/:tier/claim')
  @HttpCode(HttpStatus.OK)
  claimNatureReward(@CurrentUser() user: RequestUser, @Param('tier') tier: string) {
    const normalized = tier.trim().toUpperCase();
    if (!NATURE_TIER_NAMES.includes(normalized as (typeof NATURE_TIER_NAMES)[number])) {
      throw new BadRequestException(
        `Récompense inconnue. Valeurs acceptées : ${NATURE_TIER_NAMES.join(', ')}.`,
      );
    }
    return this.rewards.claimNatureReward(user.id, normalized);
  }
}