import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FinancialService } from './financial.service.js';
import { FinancialAdminController } from './financial-admin.controller.js';
import { FinanceAdminController } from './finance-admin.controller.js';
import { FinanceController } from './finance.controller.js';
import { TopupController } from './topup.controller.js';
import { WithdrawalController } from './withdrawal.controller.js';

/** Sprint 8.7-FIN — moteur financier RepairDom (SIMULATION) + lecture UI.
 *  Sprint SASPAY-01 — intentions de recharge + demandes de retrait + holds
 *  (fondations, sans appels prestataire réels). */
@Module({
  imports: [AuthModule],
  controllers: [
    FinancialAdminController,
    FinanceController,
    FinanceAdminController,
    TopupController,
    WithdrawalController,
  ],
  providers: [FinancialService],
  exports: [FinancialService],
})
export class FinancialModule {}