import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { PushService } from './push.service.js';
import {
  RegisterPushSubscriptionDto,
  UnregisterPushSubscriptionDto,
} from './dto/push-subscription.dto.js';

/* Push web VAPID (chantier #2B) : abonnements navigateur + test.
 * - `vapid-public-key` est PUBLIC (nécessaire au frontend pour s'abonner) ;
 * - `subscribe`/`unsubscribe`/`test` exigent une session (tous rôles) ;
 * - `test` force l'envoi même si le SSE est actif (bouton de vérification). */

@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('vapid-public-key')
  vapidPublicKey(): { publicKey: string | null } {
    return { publicKey: this.push.getVapidPublicKey() };
  }

  @Post('subscribe')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT', 'TECHNICIAN', 'ADMIN')
  @HttpCode(HttpStatus.CREATED)
  async subscribe(
    @CurrentUser() user: RequestUser,
    @Body() dto: RegisterPushSubscriptionDto,
    @Req() req: Request,
  ) {
    return this.push.registerSubscription(
      user.id,
      {
        endpoint: dto.subscription.endpoint,
        keys: dto.subscription.keys,
        deviceLabel: dto.deviceLabel,
      },
      dto.userAgent ?? req.headers['user-agent'] ?? undefined,
    );
  }

  @Delete('subscribe')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT', 'TECHNICIAN', 'ADMIN')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsubscribe(
    @CurrentUser() user: RequestUser,
    @Body() dto: UnregisterPushSubscriptionDto,
  ): Promise<void> {
    await this.push.unregisterSubscription(user.id, dto.endpoint);
  }

  @Post('test')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles('CLIENT', 'TECHNICIAN', 'ADMIN')
  @HttpCode(HttpStatus.OK)
  async test(@CurrentUser() user: RequestUser) {
    return this.push.sendToUser(
      user.id,
      {
        title: 'Notifications Relio activées',
        body: 'Vous recevrez ici les événements importants de vos missions.',
        tag: 'push-test',
        url: '/',
        type: 'push_test',
      },
      { force: true },
    );
  }
}
