import { Module } from '@nestjs/common';
import { AuthModule } from './../auth/auth.module.js';
import { FinancialModule } from './../financial/financial.module.js';
import { DemandesController } from './demandes.controller.js';
import { DemandesService } from './demandes.service.js';

@Module({
  imports: [AuthModule, FinancialModule],
  controllers: [DemandesController],
  providers: [DemandesService],
})
export class DemandesModule {}