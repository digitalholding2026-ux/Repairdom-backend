import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FinancialService } from './financial.service.js';
import { FinancialAdminController } from './financial-admin.controller.js';

/** Sprint 8.7-FIN — moteur financier RepairDom (SIMULATION). */
@Module({
  imports: [AuthModule],
  controllers: [FinancialAdminController],
  providers: [FinancialService],
  exports: [FinancialService],
})
export class FinancialModule {}