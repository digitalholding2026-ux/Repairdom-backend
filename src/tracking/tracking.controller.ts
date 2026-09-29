import { BadRequestException, Controller, Get, Param, UseGuards } from '@nestjs/common';
import { TrackingService } from './tracking.service.js';
import { TrackingThrottleGuard } from './tracking-throttle.guard.js';
import { isValidTrackingReference } from './tracking-reference.js';

@Controller('tracking')
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  /* Suivi public anonyme (produit) : format strict validé AVANT toute
   * requête DB (400 sinon) + throttle anti-balayage (429). Aucune donnée
   * privée n'est retournée (voir `TrackingService#buildPublicTracking`). */
  @Get(':reference')
  @UseGuards(TrackingThrottleGuard)
  track(@Param('reference') reference: string) {
    if (!isValidTrackingReference(reference)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: 'Référence de suivi invalide (format attendu : RD-XXXXXX).',
      });
    }
    return this.trackingService.trackByReference(reference.trim().toUpperCase());
  }
}
