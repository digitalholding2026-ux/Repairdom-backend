import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';

/* CHANTIER NAVIGATION P1/P2 — garde anti-balayage du suivi PUBLIC
 * (`GET /tracking/:reference`, anonyme par produit).
 *
 * Fenêtre glissante en mémoire : 30 requêtes / minute / IP. Au-delà → 429
 * (jamais de blocage définitif, jamais d'authentification exigée). Protège
 * contre l'énumération robotisée des références `RD-XXXXXX` sans casser le
 * suivi légitime. Volontairement sans dépendance externe (pas de Redis) :
 * adaptée à une instance unique ; les entrées expirées sont purgées à
 * chaque passage. */

export const TRACKING_THROTTLE_LIMIT = 30;
export const TRACKING_THROTTLE_WINDOW_MS = 60_000;

@Injectable()
export class TrackingThrottleGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{
      ip?: string;
      headers?: Record<string, string | string[] | undefined>;
      socket?: { remoteAddress?: string };
    }>();
    const forwarded = req.headers?.['x-forwarded-for'];
    const key =
      (Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0]?.trim()) ||
      req.ip ||
      req.socket?.remoteAddress ||
      'unknown';
    const now = Date.now();
    const windowStart = now - TRACKING_THROTTLE_WINDOW_MS;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > windowStart);
    if (recent.length >= TRACKING_THROTTLE_LIMIT) {
      this.hits.set(key, recent);
      throw new HttpException(
        'Trop de tentatives. Patientez quelques instants puis réessayez.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
