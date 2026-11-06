import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { COOKIE_NAME } from './auth.types.js';
import type { RequestUser } from './auth.types.js';

/**
 * M1 — variante non bloquante de `JwtAuthGuard` : une session valide renseigne
 * `request.user`, l'absence (ou la révocation) de session laisse la requête
 * passer en anonyme. Le catalogue public s'en sert pour choisir le tarif
 * applicable sans jamais exiger de connexion.
 */
@Injectable()
export class OptionalJwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request & { user?: RequestUser }>();
    const token = request.cookies?.[COOKIE_NAME];
    if (!token) return true;

    try {
      request.user = await this.authService.verifyToken(token);
    } catch {
      // Cookie présent mais rejeté : la lecture publique reste autorisée,
      // au tarif public.
      delete request.user;
    }
    return true;
  }
}
