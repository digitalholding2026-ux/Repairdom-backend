import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { FinancialModule } from '../financial/financial.module.js';
import { TechnicianModule } from '../technician/technician.module.js';
import { DisputesModule } from '../disputes/disputes.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { PushModule } from '../push/push.module.js';
import { CollaborationController } from './collaboration.controller.js';
import { CollaborationService } from './collaboration.service.js';

@Module({
  imports: [AuthModule, FinancialModule, TechnicianModule, DisputesModule, RealtimeModule, PushModule],
  controllers: [CollaborationController],
  providers: [CollaborationService],
})
export class CollaborationModule {}