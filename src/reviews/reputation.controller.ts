import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { ReviewsService } from './reviews.service.js';

@Controller()
@UseGuards(JwtAuthGuard)
export class ReputationController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get('technicians/:id/reputation')
  getTechnicianReputation(@Param('id') id: string) {
    return this.reviewsService.getReputation(id);
  }

  @Get('clients/:id/reputation')
  getClientReputation(@Param('id') id: string) {
    return this.reviewsService.getReputation(id);
  }
}