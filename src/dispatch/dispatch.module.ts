import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DispatchService } from './dispatch.service.js';
import { DispatchScheduler } from './dispatch.scheduler.js';

/* Sprint DISPATCH-V1 — Dispatch intelligent (vague 1 à la création,
 * vague 2 ville entière +10 min, STOP ensuite). Importé par DemandesModule
 * pour le déclenchement vague 1 ; le scheduler interne balaye les vagues 2
 * dues depuis la vérité persistée (DispatchWave). */
@Module({
  imports: [AuthModule],
  providers: [DispatchService, DispatchScheduler],
  exports: [DispatchService],
})
export class DispatchModule {}
