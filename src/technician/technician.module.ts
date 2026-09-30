import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { AiModule } from '../ai/ai.module.js';
import { TechnicianController } from './technician.controller.js';
import { TechniciansPublicController } from './technicians-public.controller.js';
import { TechnicianService } from './technician.service.js';
import { SupabaseStorageService } from './supabase-storage.service.js';
import { DemandeMediaService } from '../demandes/demande-media.service.js';

@Module({
  imports: [AuthModule, ReviewsModule, AiModule],
  controllers: [TechnicianController, TechniciansPublicController],
  providers: [TechnicianService, SupabaseStorageService, DemandeMediaService],
  exports: [SupabaseStorageService, DemandeMediaService],
})
export class TechnicianModule {}