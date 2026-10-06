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
import { DemandeDraftController } from './demande-draft.controller.js';
import { DemandeDraftService } from './demande-draft.service.js';
import { DraftThrottleGuard } from './demande-draft-throttle.guard.js';

/* `RewardsModule` est importé ici (et UNIQUEMENT ici) pour câbler le
 * comptage des récompenses sur la confirmation de mission. Pas de cycle :
 * `RewardsModule` ne réimporte jamais `DemandesModule`. */

/* Chantier D1 — `DemandeDraftService` est déclaré DANS `DemandesModule`, pas
 * dans un module séparé.
 *
 * C'est ce qui SUPPRIME la dépendance circulaire qui aurait été ailleurs :
 * `DemandeDraftService` a besoin de `DemandesService` (il appelle
 * `DemandesService.create`), et un `DemandeDraftModule` séparé aurait dû
 * importer `DemandesModule` — alors que `DemandesModule` n'a structurellement
 * aucune raison d'importer le brouillon. En gardant les deux dans le même
 * module, la résolution se fait localement, AUCUN `forwardRef()` n'est
 * nécessaire, et le cycle ne peut pas se former.
 *
 * `DemandesService` n'est pas exporté : le contrôleur de brouillon vit dans
 * le même module et l'utilise en provider local, donc rien ne sort. */
@Module({
  imports: [AuthModule, FinancialModule, DispatchModule, TechnicianModule, DisputesModule, RealtimeModule, RewardsModule],
  controllers: [DemandesController, DemandeDraftController],
  providers: [DemandesService, DemandeDraftService, DraftThrottleGuard],
})
export class DemandesModule {}