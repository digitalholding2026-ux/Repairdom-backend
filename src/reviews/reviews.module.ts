import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ReviewsController } from './reviews.controller.js';
import { ReputationController } from './reputation.controller.js';
import { ReviewsService } from './reviews.service.js';

@Module({
  imports: [AuthModule],
  controllers: [ReviewsController, ReputationController],
  providers: [ReviewsService],
  exports: [ReviewsService],
})
export class ReviewsModule {}