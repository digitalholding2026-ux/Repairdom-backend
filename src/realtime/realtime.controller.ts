import {
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard.js';
import { RolesGuard } from '../auth/roles.guard.js';
import { Roles } from '../auth/roles.decorator.js';
import { CurrentUser } from '../auth/current-user.decorator.js';
import type { RequestUser } from '../auth/auth.types.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from './realtime.service.js';
import { TECHNICIAN_AVAILABLE_CHANNEL, missionChannel, userChannel } from './realtime.types.js';

/* SOCLE TEMPS RÉEL — endpoints SSE (serveur → client uniquement).
 *
 * Headers exigés (proxies Railway/Cloudflare) : `text/event-stream`,
 * `no-cache, no-transform`, `keep-alive`, `X-Accel-Buffering: no`.
 * Auth : JwtAuthGuard (cookie HttpOnly, cross-site OK en SameSite=None;
 * Secure) + RolesGuard. CORS + credentials déjà globaux (main.ts).
 * La connexion reste ouverte : le handler ne retourne rien (réponse
 * gérée manuellement). Cleanup via `req.on('close')` côté service. */

function sseHeaders(res: Response): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
}

@Controller('realtime')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RealtimeController {
  constructor(
    private readonly realtime: RealtimeService,
    private readonly prisma: PrismaService,
  ) {}

  /** Flux personnel : notifications + statuts des missions de l'utilisateur. */
  @Get('user')
  @Roles('CLIENT', 'TECHNICIAN', 'ADMIN')
  streamUser(@CurrentUser() user: RequestUser, @Req() req: Request, @Res() res: Response): void {
    sseHeaders(res);
    this.realtime.subscribe(user.id, user.role, [userChannel(user.id)], res, req);
  }

  /** Flux d'une mission : chat, statuts, GPS. Accès réservé au client
   *  propriétaire ou au technicien assigné (sinon 403, mission inconnue 404). */
  @Get('missions/:demandeId')
  @Roles('CLIENT', 'TECHNICIAN')
  async streamMission(
    @CurrentUser() user: RequestUser,
    @Param('demandeId') demandeId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const demande = await this.prisma.demande.findUnique({
      where: { id: demandeId },
      select: { id: true, clientId: true, technicianId: true },
    });
    if (!demande) throw new NotFoundException('Demande introuvable.');
    if (demande.clientId !== user.id && demande.technicianId !== user.id) {
      throw new ForbiddenException("Vous n'avez pas accès à cette mission.");
    }
    sseHeaders(res);
    this.realtime.subscribe(user.id, user.role, [missionChannel(demandeId)], res, req);
  }

  /** Flux des missions disponibles (techniciens uniquement) + personnel. */
  @Get('technician/stream')
  @Roles('TECHNICIAN')
  streamTechnician(@CurrentUser() user: RequestUser, @Req() req: Request, @Res() res: Response): void {
    sseHeaders(res);
    this.realtime.subscribe(
      user.id,
      user.role,
      [TECHNICIAN_AVAILABLE_CHANNEL, userChannel(user.id)],
      res,
      req,
    );
  }
}
