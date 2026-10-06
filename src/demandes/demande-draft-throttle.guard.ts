import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';

/* Chantier D1 — rate-limit des routes PUBLIQUES de brouillon.
 *
 * Modèle : `TrackingThrottleGuard` (fenêtre glissante en mémoire, clé IP,
 * purge à chaque passage). Aucune dépendance ajoutée, pas de Redis — cohérent
 * avec le reste du dépôt qui tourne sur une instance unique.
 *
 * CHOIX : un seul guard lisible via métadonnée plutôt que trois classes.
 * Les quotas sont exprimés là où la route est déclarée, ce qui évite qu'une
 * limite ne vive dans un fichier différent de celui qui déclare la route.
 *
 * Quotas (décision D1) : 10 créations / heure / IP, 30 mises à jour, 60
 * lectures. Volontairement plus stricts sur la création, seule action qui
 * écrit en base : elle est la seule depuis laquelle un attaquant peut
 * gonfler la table.
 *
 * Le `token` n'est JAMAIS journalisé (voir `DemandeDraftService`) : il est un
 * secret au même titre qu'un lien de réinitialisation de mot de passe. */

export const DRAFT_THROTTLE_KEY = 'draft_throttle';

export interface DraftThrottleOptions {
  limit: number;
  windowMs: number;
}

/* 1 heure — fenêtre des quotas D1. */
export const DRAFT_THROTTLE_WINDOW_MS = 60 * 60 * 1000;

export const DraftThrottle = (limit: number, windowMs = DRAFT_THROTTLE_WINDOW_MS) =>
  SetMetadata(DRAFT_THROTTLE_KEY, { limit, windowMs });

@Injectable()
export class DraftThrottleGuard implements CanActivate {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<DraftThrottleOptions | undefined>(
      DRAFT_THROTTLE_KEY,
      [context.getHandler(), context.getClass()],
    );
    /* Route sans quota déclaré : on laisse passer. Le guard n'est de toute
     * façon monté que sur les endpoints qui en portent un. */
    if (!options) return true;

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
    const windowStart = now - options.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((at) => at > windowStart);
    if (recent.length >= options.limit) {
      this.hits.set(key, recent);
      throw new HttpException(
        'Trop de tentatives. Patientez puis réessayez.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}