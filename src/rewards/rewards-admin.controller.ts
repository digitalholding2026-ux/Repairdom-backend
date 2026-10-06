import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { RewardsService } from './rewards.service.js';
import { ResolveRewardFraudDto } from './dto/resolve-reward-fraud.dto.js';

/**
 * Chantier #4A — Signalements anti-fraude du programme de récompenses, espace
 * ADMIN.
 *
 * Contrôleur dédié plutôt qu'une greffe dans `AdminController` : le back-office
 * des récompenses est un domaine à part (le module `rewards` est importé par
 * `DemandesModule`), et l'éclatement évite que `AdminModule` dépende de
 * `RewardsModule`. `RewardsModule` n'a donc AUCUNE dépendance vers l'admin :
 * le graphe de modules reste sans cycle.
 *
 * Le cadrage demande une interface admin « simple » : deux endpoints, aucune
 * page. La décision se prend donc hors produit, depuis la liste.
 */
@Controller('admin/rewards')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class RewardsAdminController {
  constructor(private readonly rewards: RewardsService) {}

  /**
   * Liste les signalements. `?resolved=false` (défaut) = dossier ouverts,
   * `?resolved=true` = traités. Sans paramètre : tous.
   */
  @Get('frauds')
  listFraudFlags(@Query('resolved') resolved?: string) {
    if (resolved === undefined) return this.rewards.listFraudFlags();
    if (resolved === 'true') return this.rewards.listFraudFlags({ resolved: true });
    if (resolved === 'false') return this.rewards.listFraudFlags({ resolved: false });
    throw new BadRequestException('Paramètre « resolved » invalide : utilisez true ou false.');
  }

  /** Tranche un signalement : `VALIDATED` compte la mission, `REJECTED` non. */
  @Patch('frauds/:id/resolve')
  resolveFraud(
    @CurrentUser() user: RequestUser,
    @Param('id') id: string,
    @Body() dto: ResolveRewardFraudDto,
  ) {
    return this.rewards.resolveFraudFlag(id, dto.decision, user.id, dto.note);
  }
}
