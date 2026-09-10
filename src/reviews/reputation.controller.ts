import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { ReviewsService } from './reviews.service.js';

@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReputationController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Get('technicians/:id/reputation')
  @Roles('CLIENT', 'TECHNICIAN')
  getTechnicianReputation(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.reviewsService.getTechnicianReputation(user, id);
  }

  @Get('clients/:id/reputation')
  @Roles('CLIENT', 'TECHNICIAN')
  getClientReputation(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.reviewsService.getClientReputation(user, id);
  }
}