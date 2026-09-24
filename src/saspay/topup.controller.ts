import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { FinancialService } from '../financial/financial.service.js';
import { CreateTopupIntentDto } from '../financial/dto/create-topup-intent.dto.js';
import { SasPayTopupService } from './saspay-topup.service.js';

/** Recharge client Relio via SasPay (Sprint SASPAY-03, SasPayModule).
 *
 *  SIMULATION : création d'intention PENDING uniquement (aucun appel).
 *  REAL : création + initialisation softpay immédiate (Idempotency-Key =
 *  intention) → `checkoutUrl` (redirection) ou push direct (PENDING).
 *  Le crédit CLIENT_TOPUP n'intervient qu'à la confirmation serveur
 *  (webhook/verify) ; le retour navigateur ne prouve jamais rien — le
 *  frontend relit le statut Relio (GET :reference).
 *  Le compte est TOUJOURS dérivé du JWT. */
@Controller('finances/topup')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT')
export class TopupController {
  constructor(
    private readonly financial: FinancialService,
    private readonly topup: SasPayTopupService,
  ) {}

  /** Crée une intention PENDING (idempotente par idempotencyKey) et, en
   *  REAL, initialise le paiement SasPay dans la foulée. */
  @Post('intents')
  @HttpCode(HttpStatus.CREATED)
  async createIntent(@CurrentUser() user: RequestUser, @Body() dto: CreateTopupIntentDto) {
    const intent = await this.financial.createTopupIntent(user.id, user.id, dto.amount, {
      idempotencyKey: dto.idempotencyKey,
      network: dto.network ?? null,
      phone: dto.phone ?? null,
    });
    if (this.financial.getMode() !== 'REAL') {
      return { intent, saspayEnabled: false as const, checkoutUrl: null };
    }
    const init = await this.topup.initializeTopupPayment(user.id, intent.reference, {
      network: dto.network ?? null,
      phone: dto.phone ?? null,
      firstName: dto.firstName ?? null,
      lastName: dto.lastName ?? null,
      email: dto.email ?? null,
    });
    // L'init renvoie l'intention à jour (ex. FAILED + paymentError) ;
    // repli sur l'intention créée si indisponible.
    return { ...init, intent: init.intent ?? intent };
  }

  /** Liste mes intentions (traçabilité PENDING/SUCCESS/FAILED/CANCELLED). */
  @Get('intents')
  listIntents(@CurrentUser() user: RequestUser) {
    return this.financial.listTopupIntents(user.id);
  }

  /** Statut réel d'une intention (source : Relio, jamais le navigateur). */
  @Get('intents/:reference')
  async getIntent(@CurrentUser() user: RequestUser, @Param('reference') reference: string) {
    const intent = await this.financial.getTopupIntentForOwner(user.id, reference);
    if (!intent) throw new NotFoundException('Intention de recharge introuvable.');
    return { intent };
  }

  /** Vérification serveur on-demand (GET /payments/{id}/verify/), sans
   *  polling : applique les transitions idempotentes puis retourne l'état. */
  @Post('intents/:reference/verify')
  @HttpCode(HttpStatus.OK)
  verifyIntent(@CurrentUser() user: RequestUser, @Param('reference') reference: string) {
    return this.topup.verifyTopupPayment(user.id, reference);
  }
}
