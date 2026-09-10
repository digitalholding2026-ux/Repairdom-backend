import { Controller, Get, Param } from '@nestjs/common';
import { TrackingService } from './tracking.service.js';

@Controller('tracking')
export class TrackingController {
  constructor(private readonly trackingService: TrackingService) {}

  @Get(':reference')
  track(@Param('reference') reference: string) {
    return this.trackingService.trackByReference(reference);
  }
}
