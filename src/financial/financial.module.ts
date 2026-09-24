import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FinancialService } from './financial.service.js';
import { FinancialAdminController } from './financial-admin.controller.js';
import { FinanceAdminController } from './finance-admin.controller.js';
import { FinanceController } from './finance.controller.js';
import { WithdrawalController } from './withdrawal.controller.js';

/** Sprint 8.7-FIN — moteur financier RepairDom (SIMULATION) + lecture UI.
 *  Sprint SASPAY-01 — demandes de retrait + holds (fondations).
 *  Sprint SASPAY-03 — la surface HTTP recharge (TopupController) vit dans
 *  SasPayModule (orchestration init/verify), le moteur reste ici. */
@Module({
  imports: [AuthModule],
  controllers: [
    FinancialAdminController,
    FinanceController,
    FinanceAdminController,
    WithdrawalController,
  ],
  providers: [FinancialService],
  exports: [FinancialService],
})
export class FinancialModule {}