import { Module } from '@nestjs/common';
import { RealtimeController } from './realtime.controller.js';
import { RealtimeService } from './realtime.service.js';

/* SOCLE TEMPS RÉEL (SSE) — module feuille : aucune dépendance métier
 * (PrismaService est global), importé par les modules qui publient
 * (collaboration, demandes, technician, dispatch). Aucun cycle possible. */
@Module({
  controllers: [RealtimeController],
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
