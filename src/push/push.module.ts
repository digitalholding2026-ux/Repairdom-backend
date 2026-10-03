import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { RealtimeModule } from '../realtime/realtime.module.js';
import { PushController } from './push.controller.js';
import { PushService } from './push.service.js';

/* Push web VAPID (chantier #2B) : dépend du RealtimeModule UNIQUEMENT dans
 * ce sens (anti-doublon SSE → skip), + AuthModule pour les guards du
 * contrôleur. Aucun cycle : RealtimeModule n'importe jamais PushModule
 * (pas de forwardRef nécessaire). */
@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [PushController],
  providers: [PushService],
  exports: [PushService],
})
export class PushModule {}
