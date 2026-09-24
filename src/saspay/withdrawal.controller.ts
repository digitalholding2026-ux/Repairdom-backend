import { Body, Controller, Get, HttpCode, HttpStatus, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { FinancialService } from '../financial/financial.service.js';
import { CreateWithdrawalRequestDto } from '../financial/dto/create-withdrawal-request.dto.js';
import { SasPayPayoutService } from './saspay-payout.service.js';

/** Demandes de retrait client/technicien (Sprint PAYOUT, SasPayModule).
 *
 *  Création = hold ACTIVE + demande PENDING (fonds gelés, aucun débit).
 *  En REAL, enchaîne l'init `POST /payouts/initialize/` (Idempotency-Key =
 *  demande). Le débit définitif (CLIENT_/TECHNICIAN_WITHDRAWAL, au `charged`
 *  constaté) n'est créé qu'au SUCCESS confirmé serveur (webhook/verify) ;
 *  en cas d'échec les fonds sont libérés.
 *  Séparation CLIENT/TECHNICIAN : le compte est TOUJOURS dérivé du JWT
 *  (type de débit déduit du rôle du propriétaire au règlement). Le frontend
 *  n'appelle jamais SasPay directement. */
@Controller('finances/withdrawals')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT', 'TECHNICIAN')
export class WithdrawalController {
  constructor(
    private readonly financial: FinancialService,
    private readonly payout: SasPayPayoutService,
  ) {}

  /** Crée une demande PENDING + hold (idempotente par idempotencyKey) et, en
   *  REAL, initialise le payout SasPay dans la foulée. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createRequest(@CurrentUser() user: RequestUser, @Body() dto: CreateWithdrawalRequestDto) {
    const request = await this.financial.createWithdrawalRequest(user.id, user.id, dto.amount, {
      idempotencyKey: dto.idempotencyKey,
      network: dto.network ?? null,
      msisdn: dto.msisdn ?? null,
    });
    if (this.financial.getMode() !== 'REAL') {
      return { request, saspayEnabled: false as const, paymentError: null };
    }
    const init = await this.payout.initializeWithdrawalPayout(user.id, request.reference, {
      network: dto.network ?? null,
      msisdn: dto.msisdn ?? null,
    });
    return { ...init, request: init.request ?? request };
  }

  /** Liste mes demandes (traçabilité PENDING/SUCCESS/FAILED/CANCELLED). */
  @Get()
  listRequests(@CurrentUser() user: RequestUser) {
    return this.financial.listWithdrawalRequests(user.id);
  }

  /** Statut réel d'une demande (source : Relio, jamais SasPay direct). */
  @Get(':reference')
  async getRequest(@CurrentUser() user: RequestUser, @Param('reference') reference: string) {
    const request = await this.financial.getWithdrawalRequestForOwner(user.id, reference);
    if (!request) throw new NotFoundException('Demande de retrait introuvable.');
    return { request };
  }

  /** Vérification serveur on-demand (GET /payouts/{id}/verify/), sans
   *  polling : applique les transitions idempotentes puis retourne l'état. */
  @Post(':reference/verify')
  @HttpCode(HttpStatus.OK)
  verifyRequest(@CurrentUser() user: RequestUser, @Param('reference') reference: string) {
    return this.payout.verifyWithdrawalPayout(user.id, reference);
  }
}
