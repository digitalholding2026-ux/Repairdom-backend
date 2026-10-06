import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { PushModule } from '../push/push.module.js';
import { RewardsController } from './rewards.controller.js';
import { RewardsAdminController } from './rewards-admin.controller.js';
import { RewardsNotificationsService } from './rewards-notifications.service.js';
import { RewardsService } from './rewards.service.js';

/**
 * Chantier #4A — Programme de récompenses client.
 *
 * ── Graphe de modules, et absence de cycle ──────────────────────────
 *
 *   RewardsModule ──▶ AuthModule      (EmailService)
 *   RewardsModule ──▶ RealtimeModule  (RealtimeService — SSE)
 *   RewardsModule ──▶ PushModule      (PushService — VAPID)
 *   RewardsModule ──▶ PrismaModule    (global, implicite)
 *   DemandesModule ──▶ RewardsModule  (RewardsService, pour le wiring de la
 *                                      confirmation de mission)
 *
 * `RewardsModule` n'importe NI `DemandesModule`, NI `AdminModule`, NI
 * `TechnicianModule` : le cycle feared (`DemandesModule ⇄ RewardsModule`)
 * n'existe donc pas et aucun `forwardRef` n'est nécessaire. Les deux points
 * d'entrée (`/client/rewards` et `/admin/rewards`) sont des contrôleurs à
 * gardes, ils n'ont besoin que des guards d'`AuthModule`.
 *
 * Le `PrismaModule` est `@Global` : il n'apparaît pas dans les imports, comme
 * dans tous les autres modules métier du projet.
 *
 * `PushModule` importe `RealtimeModule`, qui importe `AuthModule` : les
 * imports ci-dessus sont doncredondants par ordre de dépendance, mais
 * explicites (convention du projet — aucune dépendance implicite).
 */
@Module({
  imports: [AuthModule, RealtimeModule, PushModule],
  controllers: [RewardsController, RewardsAdminController],
  providers: [RewardsService, RewardsNotificationsService],
  /* `RewardsService` est consommé par `DemandesModule` (wiring de la
   * confirmation) ; `RewardsNotificationsService` reste interne au module
   * (aucun autre module n'en a besoin). */
  exports: [RewardsService],
})
export class RewardsModule {}
