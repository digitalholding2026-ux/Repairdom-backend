import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { FinancialService } from './financial.service.js';
import { CreateTopupIntentDto } from './dto/create-topup-intent.dto.js';

/** Intentions de recharge client (fondations SASPAY-01).
 *  Le compte est TOUJOURS dérivé du JWT ; la création ne crédite rien —
 *  le crédit CLIENT_TOPUP n'intervient qu'à la confirmation serveur
 *  (webhook SasPay → FinancialService.confirmTopupIntent). */
@Controller('finances/topup')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT')
export class TopupController {
  constructor(private readonly financial: FinancialService) {}

  /** Crée une intention PENDING (idempotente par idempotencyKey). */
  @Post('intents')
  @HttpCode(HttpStatus.CREATED)
  createIntent(@CurrentUser() user: RequestUser, @Body() dto: CreateTopupIntentDto) {
    return this.financial.createTopupIntent(user.id, user.id, dto.amount, {
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** Liste mes intentions (traçabilité PENDING/SUCCESS/FAILED/CANCELLED). */
  @Get('intents')
  listIntents(@CurrentUser() user: RequestUser) {
    return this.financial.listTopupIntents(user.id);
  }
}
