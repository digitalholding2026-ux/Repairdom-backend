import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { ReviewsModule } from '../reviews/reviews.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { PushModule } from '../push/push.module.js';
import { TechnicianController } from './technician.controller.js';
import { TechniciansPublicController } from './technicians-public.controller.js';
import { TechnicianService } from './technician.service.js';
import { SupabaseStorageService } from './supabase-storage.service.js';
import { DemandeMediaService } from '../demandes/demande-media.service.js';

@Module({
  imports: [AuthModule, ReviewsModule, RealtimeModule, PushModule],
  controllers: [TechnicianController, TechniciansPublicController],
  providers: [TechnicianService, SupabaseStorageService, DemandeMediaService],
  exports: [SupabaseStorageService, DemandeMediaService],
})
export class TechnicianModule {}