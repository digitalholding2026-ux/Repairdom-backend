import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { PushModule } from '../push/push.module.js';
import { ReferralsController } from './referrals.controller.js';
import { ReferralsNotificationsService } from './referrals-notifications.service.js';
import { ReferralsService } from './referrals.service.js';

/**
 * Chantier 4B — Parrainage client.
 *
 * ── Graphe de modules, et absence de cycle ──────────────────────────
 *
 *   ReferralsModule ──▶ AuthModule      (EmailService — les 2 envois)
 *   ReferralsModule ──▶ RealtimeModule  (RealtimeService — SSE)
 *   ReferralsModule ──▶ PushModule      (PushService — VAPID)
 *   ReferralsModule ──▶ PrismaModule    (global, implicite)
 *   DemandesModule ──▶ ReferralsModule (ReferralsService, câblage confirmation)
 *
 * `ReferralsModule` n'importe NI `DemandesModule`, NI `FinancialModule`, NI
 * `AuthModule` en sens inverse. Deux décisions méritent d'être notées :
 *
 * 1. **Pas d'import de `FinancialModule`.** Le mode financier est lu via
 *    `ConfigService` (`FINANCIAL_MODE`), pas via `FinancialService`. Le
 *    module financier importe `DemandesModule`, qui importe
 *    `ReferralsModule` : passer par `FinancialService` aurait créé
 *    `Referrals → Financial → Demandes → Referrals`. Le mode reste une
 *    décision serveur dans les deux cas — le client ne le choisit jamais.
 *
 * 2. **`AuthModule` n'importe pas `ReferralsModule`.** L'inscription doit
 *    appeler `ReferralsService.registerReferral`, ce qui donnerait
 *    `Auth → Referrals → Auth`. Le cycle est ROMPU par une résolution
 *    LAZY : `AuthService` ne déclare aucune dépendance sur `ReferralsModule`
 *    et résout le service au moment de l'appel via `ModuleRef`. Aucune
 *    initialisation de module ne dépend donc de l'autre — le cycle n'existe
 *    pas, seulement une recherche au runtime, protégée par `try/catch`
 *    (l'inscription ne doit jamais échouer pour un parrainage).
 *
 * `PrismaModule` et `ConfigModule` sont globaux : ils n'apparaissent pas dans
 * les imports, comme dans tous les autres modules métier du dépôt.
 */
@Module({
  imports: [AuthModule, RealtimeModule, PushModule],
  controllers: [ReferralsController],
  providers: [ReferralsService, ReferralsNotificationsService],
  /* `ReferralsService` est consommé par `DemandesModule` (confirmation) et,
   * par résolution lazy, par `AuthService` (inscription).
   * `ReferralsNotificationsService` reste interne : aucun autre module n'a
   * besoin de notifier une récompense. */
  exports: [ReferralsService],
})
export class ReferralsModule {}