import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { FinancialService } from './financial.service.js';
import type { AdminFinanceFilters } from './financial.service.js';
import { AdminFinanceQueryDto } from './dto/admin-finance-query.dto.js';
import { RelioWithdrawDto } from './dto/relio-withdraw.dto.js';

/** Supervision financière ADMIN (Sprint 8.7-FIN-UI). READ-ONLY.
 *  Les filtres (mode, période, référence mission) sont appliqués par le
 *  backend ; la page frontend affiche un résultat déjà agrégé. */
@Controller('admin/finances')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class FinanceAdminController {
  constructor(private readonly financial: FinancialService) {}

  /** Synthèse globale par mode (SIMULATION / REAL). */
  @Get()
  summary(@Query() query: AdminFinanceQueryDto) {
    const filters: AdminFinanceFilters = {};
    if (query.mode) filters.mode = query.mode;
    if (query.from) filters.from = new Date(query.from);
    if (query.to) filters.to = new Date(query.to);
    if (query.reference?.trim()) filters.reference = query.reference.trim();
    return this.financial.getAdminFinanceSummary(filters);
  }

  /** Détail financier d'une mission (transactions ledger immuables incluses). */
  @Get('missions/:demandeId')
  missionDetail(@Param('demandeId') demandeId: string) {
    return this.financial.getAdminMissionFinance(demandeId);
  }

  /* ── Fonds Relio (Sprint ADMIN SUPER POWERS) ──────────────── */
  /* Commissions acquises / retirées / disponibles (calculées depuis le
   * ledger, jamais stockées), retraits traçables et historique. */

  /** Synthèse des fonds Relio du mode serveur (SIMULATION par défaut). */
  @Get('relio-funds/summary')
  relioFundsSummary() {
    return this.financial.getRelioFunds();
  }

  /** Historique des retraits Relio (date, montant, admin, référence, statut). */
  @Get('relio-funds/withdrawals')
  relioWithdrawals() {
    return this.financial.listRelioWithdrawals();
  }

  /** Retrait des fonds Relio. Le backend refuse tout montant supérieur au
   *  disponible ; retraits concurrents sérialisés, références uniques. */
  @Post('relio-funds/withdrawals')
  relioWithdraw(@Body() dto: RelioWithdrawDto, @CurrentUser() user: RequestUser) {
    return this.financial.withdrawRelioFunds(user.id, dto.amount, dto.note ?? null);
  }
}