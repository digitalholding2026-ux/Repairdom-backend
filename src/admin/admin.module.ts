import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TechnicianModule } from '../technician/technician.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';

@Module({
  imports: [AuthModule, TechnicianModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}