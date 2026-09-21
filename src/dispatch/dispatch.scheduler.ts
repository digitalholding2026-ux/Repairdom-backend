import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DispatchService } from './dispatch.service.js';

/* Sprint DISPATCH-V1 — Ordonnanceur des vagues 2 (+10 minutes).
 *
 * AUCUNE nouvelle dépendance (ni @nestjs/schedule, ni Redis/BullMQ : pas de
 * régénération de lockfile, pas de service externe) et AUCUN setTimeout
 * porteur de logique métier : un balayage périodique interroge la vérité
 * persistée (`DispatchWave.sentAt`), donc un redémarrage Railway ne perd
 * jamais une vague — au redémarrage, les vagues dues sont simplement
 * reprises au prochain balayage. Garde anti-chevauchement intra-processus ;
 * l'idempotence inter-instances repose sur la contrainte unique
 * (demandeId, vague, technicien, canal) + la revérification du statut
 * dans chaque vague (voir DispatchService).
 */
const DISPATCH_SWEEP_INTERVAL_MS = 60 * 1000;

@Injectable()
export class DispatchScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DispatchScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly dispatch: DispatchService) {}

  onModuleInit() {
    this.timer = setInterval(() => {
      void this.sweep();
    }, DISPATCH_SWEEP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async sweep() {
    if (this.running) return;
    this.running = true;
    try {
      await this.dispatch.dispatchDueWave2(new Date());
    } catch (error) {
      this.logger.error(
        `Balayage dispatch impossible : ${error instanceof Error ? error.message : 'erreur inconnue'}.`,
      );
    } finally {
      this.running = false;
    }
  }
}
