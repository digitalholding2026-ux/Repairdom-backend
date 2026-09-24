import { Body, Controller, Get, HttpCode, HttpStatus, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { FinancialService } from './financial.service.js';
import { CreateWithdrawalRequestDto } from './dto/create-withdrawal-request.dto.js';

/** Demandes de retrait client/technicien (fondations SASPAY-01).
 *  Création = hold ACTIVE + demande PENDING (fonds gelés, aucun débit).
 *  Le débit définitif (CLIENT_WITHDRAWAL/TECHNICIAN_WITHDRAWAL) n'est créé
 *  qu'au SUCCESS du payout ; en cas d'échec les fonds sont libérés.
 *  Le compte est TOUJOURS dérivé du JWT. */
@Controller('finances/withdrawals')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT', 'TECHNICIAN')
export class WithdrawalController {
  constructor(private readonly financial: FinancialService) {}

  /** Crée une demande PENDING + hold (idempotente par idempotencyKey). */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  createRequest(@CurrentUser() user: RequestUser, @Body() dto: CreateWithdrawalRequestDto) {
    return this.financial.createWithdrawalRequest(user.id, user.id, dto.amount, {
      idempotencyKey: dto.idempotencyKey,
    });
  }

  /** Liste mes demandes (traçabilité PENDING/SUCCESS/FAILED/CANCELLED). */
  @Get()
  listRequests(@CurrentUser() user: RequestUser) {
    return this.financial.listWithdrawalRequests(user.id);
  }
}
