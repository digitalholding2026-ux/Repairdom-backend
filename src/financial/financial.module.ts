import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FinancialService } from './financial.service.js';
import { FinancialAdminController } from './financial-admin.controller.js';
import { FinanceAdminController } from './finance-admin.controller.js';
import { FinanceController } from './finance.controller.js';

/** Sprint 8.7-FIN — moteur financier RepairDom (SIMULATION) + lecture UI. */
@Module({
  imports: [AuthModule],
  controllers: [
    FinancialAdminController,
    FinanceController,
    FinanceAdminController,
  ],
  providers: [FinancialService],
  exports: [FinancialService],
})
export class FinancialModule {}