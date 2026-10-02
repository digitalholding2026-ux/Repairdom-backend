import { Module } from '@nestjs/common';
import { AuthModule } from './../auth/auth.module.js';
import { FinancialModule } from './../financial/financial.module.js';
import { DispatchModule } from './../dispatch/dispatch.module.js';
import { TechnicianModule } from './../technician/technician.module.js';
import { AiModule } from './../ai/ai.module.js';
import { DisputesModule } from './../disputes/disputes.module.js';
import { RealtimeModule } from './../realtime/realtime.module.js';
import { DemandesController } from './demandes.controller.js';
import { DemandesService } from './demandes.service.js';

@Module({
  imports: [AuthModule, FinancialModule, DispatchModule, TechnicianModule, AiModule, DisputesModule, RealtimeModule],
  controllers: [DemandesController],
  providers: [DemandesService],
})
export class DemandesModule {}