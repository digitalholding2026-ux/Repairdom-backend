import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TechnicianController } from './technician.controller.js';
import { TechniciansPublicController } from './technicians-public.controller.js';
import { TechnicianService } from './technician.service.js';

@Module({
  imports: [AuthModule],
  controllers: [TechnicianController, TechniciansPublicController],
  providers: [TechnicianService],
})
export class TechnicianModule {}