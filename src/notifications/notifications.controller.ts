import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  UseGuards,
} from '@nestjs/common';
import { NotificationsService } from './notifications.service.js';
import { JwtAuthGuard } from './../auth/jwt-auth.guard.js';
import { RolesGuard } from './../auth/roles.guard.js';
import { Roles } from './../auth/roles.decorator.js';
import { CurrentUser } from './../auth/current-user.decorator.js';
import type { RequestUser } from './../auth/auth.types.js';

@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT', 'TECHNICIAN')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get('mine')
  listMine(@CurrentUser() user: RequestUser) {
    return this.notificationsService.listMine(user.id);
  }

  @Get('unread-count')
  unreadCount(@CurrentUser() user: RequestUser) {
    return this.notificationsService.unreadCount(user.id);
  }

  @Patch('read-all')
  @HttpCode(HttpStatus.OK)
  markAllRead(@CurrentUser() user: RequestUser) {
    return this.notificationsService.markAllRead(user.id);
  }

  @Patch(':id/read')
  @HttpCode(HttpStatus.OK)
  markRead(@CurrentUser() user: RequestUser, @Param('id') id: string) {
    return this.notificationsService.markRead(user.id, id);
  }
}