import { Module } from '@nestjs/common';
import { AuthModule } from './../auth/auth.module.js';
import { FinancialModule } from './../financial/financial.module.js';
import { DispatchModule } from './../dispatch/dispatch.module.js';
import { TechnicianModule } from './../technician/technician.module.js';
import { DisputesModule } from './../disputes/disputes.module.js';
import { RealtimeModule } from './../realtime/realtime.module.js';
import { RewardsModule } from './../rewards/rewards.module.js';
import { DemandesController } from './demandes.controller.js';
import { DemandesService } from './demandes.service.js';

/* `RewardsModule` est importé ici (et UNIQUEMENT ici) pour câbler le
 * comptage des récompenses sur la confirmation de mission. Pas de cycle :
 * `RewardsModule` ne réimporte jamais `DemandesModule`. */
@Module({
  imports: [AuthModule, FinancialModule, DispatchModule, TechnicianModule, DisputesModule, RealtimeModule, RewardsModule],
  controllers: [DemandesController],
  providers: [DemandesService],
})
export class DemandesModule {}