import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import { CollaborationService } from './collaboration.service.js';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { SendMessageDto } from './dto/send-message.dto.js';
import { CreateDiagnosticDto } from './dto/create-diagnostic.dto.js';
import { CreateQuoteDto } from './dto/create-quote.dto.js';

@Controller('demandes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('CLIENT', 'TECHNICIAN')
export class CollaborationController {
  constructor(private readonly collaborationService: CollaborationService) {}

  @Get(':demandeId/messages')
  listMessages(@CurrentUser() user: RequestUser, @Param('demandeId') demandeId: string) {
    return this.collaborationService.listMessages(user, demandeId);
  }

  @Post(':demandeId/messages')
  sendMessage(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Body() dto: SendMessageDto,
  ) {
    return this.collaborationService.sendMessage(user, demandeId, dto);
  }

  @Get(':demandeId/diagnostics')
  listDiagnostics(@CurrentUser() user: RequestUser, @Param('demandeId') demandeId: string) {
    return this.collaborationService.listDiagnostics(user, demandeId);
  }

  @Post(':demandeId/diagnostic')
  createDiagnostic(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Body() dto: CreateDiagnosticDto,
  ) {
    return this.collaborationService.createDiagnostic(user, demandeId, dto);
  }

  @Get(':demandeId/quotes')
  listQuotes(@CurrentUser() user: RequestUser, @Param('demandeId') demandeId: string) {
    return this.collaborationService.listQuotes(user, demandeId);
  }

  @Post(':demandeId/quotes')
  createQuote(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Body() dto: CreateQuoteDto,
  ) {
    return this.collaborationService.createQuote(user, demandeId, dto);
  }

  @Post(':demandeId/quotes/:quoteId/accept')
  @HttpCode(HttpStatus.OK)
  acceptQuote(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Param('quoteId') quoteId: string,
  ) {
    return this.collaborationService.respondToQuote(user, demandeId, quoteId, 'accept');
  }

  @Post(':demandeId/quotes/:quoteId/reject')
  @HttpCode(HttpStatus.OK)
  rejectQuote(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Param('quoteId') quoteId: string,
  ) {
    return this.collaborationService.respondToQuote(user, demandeId, quoteId, 'reject');
  }

  @Get(':demandeId/summary')
  summary(@CurrentUser() user: RequestUser, @Param('demandeId') demandeId: string) {
    return this.collaborationService.summary(user, demandeId);
  }
}