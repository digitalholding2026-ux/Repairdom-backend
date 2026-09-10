import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TechnicianModule } from '../technician/technician.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogPublicController } from './catalog-public.controller.js';
import { CatalogService } from './catalog.service.js';

@Module({
  imports: [AuthModule, TechnicianModule],
  controllers: [AdminController, CatalogController, CatalogPublicController],
  providers: [AdminService, CatalogService],
})
export class AdminModule {}