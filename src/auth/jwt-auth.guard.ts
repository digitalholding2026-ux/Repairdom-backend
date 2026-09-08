import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from './auth.service.js';
import { COOKIE_NAME } from './auth.types.js';
import type { RequestUser } from './auth.types.js';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest() as Request;
    const token = request.cookies?.[COOKIE_NAME];
    if (!token) throw new UnauthorizedException('Authentification requise.');

    const user = await this.authService.verifyToken(token);
    (request as Request & { user: RequestUser }).user = user;
    return true;
  }
}