import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { BackofficeAgentService } from './backoffice-agent.service.js';
import { AgentChatDto } from './dto/agent-chat.dto.js';

/* Agent IA Backoffice — STRICTEMENT réservé à l'administration.
 * Aucune autre route, aucun autre rôle : CLIENT et TECHNICIAN → 403. */

@Controller('admin/agent')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class BackofficeAgentController {
  constructor(private readonly agent: BackofficeAgentService) {}

  @Get('status')
  getStatus() {
    return this.agent.status();
  }

  @Post('chat')
  chat(@CurrentUser() user: RequestUser, @Body() dto: AgentChatDto) {
    return this.agent.chat(user.id, dto.message, dto.history ?? []);
  }
}
