import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { ReviewsService } from './reviews.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { CreateReviewDto } from './dto/create-review.dto.js';

@Controller('demandes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT', 'TECHNICIAN')
export class ReviewsController {
  constructor(private readonly reviewsService: ReviewsService) {}

  @Post(':demandeId/reviews')
  @HttpCode(HttpStatus.CREATED)
  createReview(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Body() dto: CreateReviewDto,
  ) {
    return this.reviewsService.createReview(user, demandeId, dto);
  }

  @Get(':demandeId/reviews')
  listReviews(@CurrentUser() user: RequestUser, @Param('demandeId') demandeId: string) {
    return this.reviewsService.listForDemande(user, demandeId);
  }
}