import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validate } from './config/env.validation.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { AuthModule } from './auth/auth.module.js';
import { DemandesModule } from './demandes/demandes.module.js';
import { TechnicianModule } from './technician/technician.module.js';
import { CollaborationModule } from './collaboration/collaboration.module.js';
import { AdminModule } from './admin/admin.module.js';
import { ReviewsModule } from './reviews/reviews.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
    }),
    PrismaModule,
    HealthModule,
    AuthModule,
    DemandesModule,
    TechnicianModule,
    CollaborationModule,
    AdminModule,
    ReviewsModule,
  ],
})
export class AppModule {}