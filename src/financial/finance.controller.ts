import { Controller, Get, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { FinancialService } from './financial.service.js';

/** Lecture financière de son propre compte (Sprint 8.7-FIN-UI).
 *  READ-ONLY : aucun userId accepté depuis le frontend — le compte est
 *  TOUJOURS dérivé du JWT de l'utilisateur connecté. */
@Controller('finances')
@UseGuards(JwtAuthGuard, RolesGuard)
export class FinanceController {
  constructor(private readonly financial: FinancialService) {}

  /** Solde SIMULATION du client connecté. */
  @Get('client/me')
  @Roles('CLIENT')
  clientSummary(@CurrentUser() user: RequestUser) {
    return this.financial.getClientFinanceSummary(user.id);
  }

  /** Revenus SIMULATION du technicien connecté. */
  @Get('technician/me')
  @Roles('TECHNICIAN')
  technicianSummary(@CurrentUser() user: RequestUser) {
    return this.financial.getTechnicianFinanceSummary(user.id);
  }
}