import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { RealtimeController } from './realtime.controller.js';
import { RealtimeService } from './realtime.service.js';

/* SOCLE TEMPS RÉEL (SSE) — module feuille métier : aucune dépendance
 * métier, mais dépendances techniques explicites (pas de global implicite) :
 * - AuthModule : JwtAuthGuard/RolesGuard (contrôleur) via AuthService ;
 * - PrismaModule : contrôle d'accès mission du contrôleur.
 * Exporté vers les modules qui publient (collaboration, demandes,
 * technician, dispatch). Aucun cycle possible. */
@Module({
  imports: [AuthModule, PrismaModule],
  controllers: [RealtimeController],
  providers: [RealtimeService],
  exports: [RealtimeService],
})
export class RealtimeModule {}
