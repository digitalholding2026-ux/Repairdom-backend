import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { TechnicianModule } from '../technician/technician.module.js';
import { DisputesModule } from '../disputes/disputes.module.js';
// Chantier #5A : canaux de la décision KYC (SSE + push web).
// `AuthModule` exporte déjà `EmailService`. `RealtimeModule` et
// `PushModule` n'importent que `AuthModule` (+ RealtimeModule pour le
// push) : aucun cycle possible, donc AUCUN `forwardRef` nécessaire.
import { RealtimeModule } from '../realtime/realtime.module.js';
import { PushModule } from '../push/push.module.js';
import { AdminController } from './admin.controller.js';
import { AdminService } from './admin.service.js';
import { CatalogController } from './catalog.controller.js';
import { CatalogPublicController } from './catalog-public.controller.js';
import { CityPublicController } from './city-public.controller.js';
import { CatalogService } from './catalog.service.js';

@Module({
  imports: [AuthModule, TechnicianModule, DisputesModule, RealtimeModule, PushModule],
  controllers: [AdminController, CatalogController, CatalogPublicController, CityPublicController],
  providers: [AdminService, CatalogService],
})
export class AdminModule {}