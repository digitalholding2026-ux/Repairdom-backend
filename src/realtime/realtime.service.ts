import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { Request } from 'express';
import type { UserRole } from '../auth/auth.types.js';
import type { RealtimeEventType } from './realtime.types.js';

/* SOCLE TEMPS RÉEL — hub SSE (serveur → client uniquement, compatible
 * CDN/proxies, sans WebSocket).
 *
 * - Registre de connexions actives : chaque connexion porte id, userId,
 *   rôle, channels souscrits et la `Response` Express retenue ouverte.
 * - `publish()` ne lève JAMAIS (hub best-effort : un bug du hub ne doit
 *   jamais casser la requête métier en cours) et ne journalise JAMAIS les
 *   payloads (PII : messages, positions GPS) — ids + types + compteurs seuls.
 * - Ping `: ping` toutes les 25 s (proxies Railway/Cloudflare).
 * - Cleanup sur `req.on('close')` (+ `error` tracé) ; max 3 connexions par
 *   utilisateur (la plus ancienne est fermée) ; backpressure : pas
 *   d'empilement si `res.write()` retourne false (drops comptés, log si
 *   > 10/min).
 */

/** Intervalle de ping SSE (proxies). Exporté pour les tests (fake timers). */
export const REALTIME_PING_INTERVAL_MS = 25_000;
/** Multisupport : desktop + mobile + fallback. Au-delà, la plus ancienne
 *  connexion est fermée proprement. Exporté pour les tests. */
export const REALTIME_MAX_CONNECTIONS_PER_USER = 3;
const DROP_LOG_THRESHOLD_PER_MINUTE = 10;
const DROP_WINDOW_MS = 60_000;

interface Subscription {
  id: string;
  userId: string;
  role: UserRole;
  channels: Set<string>;
  res: Response;
  createdAt: number;
  drops: number;
  dropWindowStart: number;
}

@Injectable()
export class RealtimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealtimeService.name);
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly userSubscriptions = new Map<string, Set<string>>();
  private pingTimer: NodeJS.Timeout | null = null;

  onModuleInit(): void {
    if (this.pingTimer) return;
    this.pingTimer = setInterval(() => this.pingAll(), REALTIME_PING_INTERVAL_MS);
    // Le timer ne doit jamais retenir le processus en vie.
    if (typeof (this.pingTimer as unknown as { unref?: () => void }).unref === 'function') {
      (this.pingTimer as unknown as { unref: () => void }).unref();
    }
  }

  onModuleDestroy(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    for (const id of this.subscriptions.keys()) {
      this.closeSubscription(id);
    }
  }

  /** Nombre de connexions actives (global ou par utilisateur). Testabilité. */
  subscriptionCount(userId?: string): number {
    if (userId === undefined) return this.subscriptions.size;
    return this.userSubscriptions.get(userId)?.size ?? 0;
  }

  subscribe(
    userId: string,
    role: UserRole,
    channels: string[],
    res: Response,
    req: Request,
  ): Subscription {
    this.evictBeyondLimit(userId);
    const subscription: Subscription = {
      id: randomUUID(),
      userId,
      role,
      channels: new Set(channels),
      res,
      createdAt: Date.now(),
      drops: 0,
      dropWindowStart: Date.now(),
    };
    this.subscriptions.set(subscription.id, subscription);
    let userSet = this.userSubscriptions.get(userId);
    if (!userSet) {
      userSet = new Set();
      this.userSubscriptions.set(userId, userSet);
    }
    userSet.add(subscription.id);
    req.on('close', () => this.unsubscribe(subscription.id));
    req.on('error', (error: unknown) => {
      this.logger.warn(
        `Connexion temps réel ${subscription.id} en erreur : ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }.`,
      );
      this.unsubscribe(subscription.id);
    });
    this.writeRaw(subscription, ': connected\n\n');
    return subscription;
  }

  unsubscribe(subscriptionId: string): boolean {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return false;
    this.subscriptions.delete(subscriptionId);
    const userSet = this.userSubscriptions.get(subscription.userId);
    if (userSet) {
      userSet.delete(subscriptionId);
      if (userSet.size === 0) this.userSubscriptions.delete(subscription.userId);
    }
    return true;
  }

  /** Diffuse un événement sur un channel. Ne lève jamais. */
  publish(channel: string, type: RealtimeEventType, payload: Record<string, unknown>): void {
    try {
      const chunk =
        `event: ${type}\n` +
        `data: ${JSON.stringify({ type, channel, payload, emittedAt: new Date().toISOString() })}\n\n`;
      for (const subscription of this.subscriptions.values()) {
        if (subscription.channels.has(channel)) {
          this.writeRaw(subscription, chunk);
        }
      }
    } catch (error) {
      this.logger.warn(
        `Diffusion temps réel impossible (${type}) : ${
          error instanceof Error ? error.message : 'erreur inconnue'
        }.`,
      );
    }
  }

  /** Diffuse un événement personnel (`user:<userId>`). Ne lève jamais. */
  publishToUser(userId: string, type: RealtimeEventType, payload: Record<string, unknown>): void {
    this.publish(`user:${userId}`, type, payload);
  }

  /* Ferme la plus ancienne connexion quand l'utilisateur dépasse le quota
   * (multisupport). Best-effort : un `end()` qui échoue n'est pas bloquant. */
  private evictBeyondLimit(userId: string): void {
    const userSet = this.userSubscriptions.get(userId);
    if (!userSet || userSet.size < REALTIME_MAX_CONNECTIONS_PER_USER) return;
    let oldest: Subscription | null = null;
    for (const id of userSet) {
      const candidate = this.subscriptions.get(id);
      if (candidate && (!oldest || candidate.createdAt < oldest.createdAt)) {
        oldest = candidate;
      }
    }
    if (oldest) {
      this.logger.log(`Connexion temps réel la plus ancienne fermée pour ${userId} (quota).`);
      this.closeSubscription(oldest.id);
    }
  }

  private closeSubscription(subscriptionId: string): void {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;
    try {
      subscription.res.end();
    } catch {
      // Fermeture best-effort : le registre est la source de vérité.
    }
    this.unsubscribe(subscriptionId);
  }

  private pingAll(): void {
    for (const subscription of this.subscriptions.values()) {
      // Ping mort = socket morte : désinscription silencieuse (le client
      // se reconnecte avec backoff, l'historique reste en base).
      if (!this.writeRaw(subscription, ': ping\n\n')) {
        this.unsubscribe(subscription.id);
      }
    }
  }

  /* Écriture brute : `false` (backpressure) ou exception → la donnée est
   * abandonnée (jamais empilée), le drop est compté (log si > 10/min). */
  private writeRaw(subscription: Subscription, chunk: string): boolean {
    try {
      const accepted = subscription.res.write(chunk);
      if (!accepted) this.recordDrop(subscription);
      return accepted;
    } catch {
      this.unsubscribe(subscription.id);
      return false;
    }
  }

  private recordDrop(subscription: Subscription): void {
    const now = Date.now();
    if (now - subscription.dropWindowStart > DROP_WINDOW_MS) {
      subscription.dropWindowStart = now;
      subscription.drops = 0;
    }
    subscription.drops += 1;
    if (subscription.drops === DROP_LOG_THRESHOLD_PER_MINUTE + 1) {
      this.logger.warn(
        `Backpressure temps réel : > ${DROP_LOG_THRESHOLD_PER_MINUTE} écritures refusées/min ` +
          `pour ${subscription.id}.`,
      );
    }
  }
}
