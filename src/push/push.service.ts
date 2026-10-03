import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webPush from 'web-push';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import type { PushSendResult, PushSubscriptionInput } from './push.types.js';

/* Push web VAPID (chantier #2B) : complément du SSE quand l'app est fermée.
 *
 * - Abonnements : upsert par `endpoint` (le navigateur réutilise le même
 *   endpoint par installation), CASCADE avec le compte.
 * - Anti-doublon : si une connexion SSE est active pour l'utilisateur, AUCUN
 *   push n'est envoyé (sauf `force: true`) — il voit déjà l'événement.
 * - Subscriptions mortes (410/404) supprimées silencieusement ; 413 loggée ;
 *   autres erreurs loggées sans propagation (le métier n'est jamais bloqué).
 * - Sans clés VAPID configurées : envoi désactivé proprement (log + skip).
 * - Ne journalise JAMAIS les endpoints ni les contenus (ids + compteurs).
 */

export const PUSH_ICON = '/brand/relio-mark.svg';

@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private vapidConfigured: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly realtime: RealtimeService,
  ) {
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY')?.trim();
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY')?.trim();
    const subject =
      this.config.get<string>('VAPID_SUBJECT')?.trim() || 'mailto:contact@relioo.space';
    this.vapidConfigured = !!publicKey && !!privateKey;
    if (this.vapidConfigured) {
      webPush.setVapidDetails(subject, publicKey as string, privateKey as string);
    } else {
      this.logger.warn(
        'Clés VAPID absentes : le push web est désactivé (voir docs/PUSH.md).',
      );
    }
  }

  getVapidPublicKey(): string | null {
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY')?.trim();
    return publicKey ? publicKey : null;
  }

  async registerSubscription(
    userId: string,
    input: PushSubscriptionInput,
    userAgent?: string,
  ) {
    const subscription = await this.prisma.pushSubscription.upsert({
      where: { endpoint: input.endpoint },
      create: {
        userId,
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: userAgent ?? input.userAgent ?? null,
        deviceLabel: input.deviceLabel ?? null,
      },
      update: {
        userId,
        p256dh: input.keys.p256dh,
        auth: input.keys.auth,
        userAgent: userAgent ?? input.userAgent ?? null,
        deviceLabel: input.deviceLabel ?? null,
        lastUsedAt: new Date(),
      },
    });
    return { id: subscription.id };
  }

  async unregisterSubscription(userId: string, endpoint: string): Promise<{ ok: boolean }> {
    // Idempotent : inexistant ou appartenant à un tiers → même réponse.
    await this.prisma.pushSubscription
      .deleteMany({ where: { userId, endpoint } })
      .catch(() => undefined);
    return { ok: true };
  }

  async unregisterAllForUser(userId: string): Promise<{ ok: boolean }> {
    await this.prisma.pushSubscription.deleteMany({ where: { userId } }).catch(() => undefined);
    return { ok: true };
  }

  async sendToUser(
    userId: string,
    payload: { title: string; body: string; tag: string; url: string; type: string },
    options: { force?: boolean } = {},
  ): Promise<PushSendResult> {
    try {
      return await this.sendToUserOrThrow(userId, payload, options);
    } catch (error) {
      // Le push ne bloque JAMAIS le flux métier appelant.
      this.logger.warn(
        `Push impossible pour ${userId} : ${error instanceof Error ? error.message : 'erreur inconnue'}.`,
      );
      return { sent: 0, skipped: null, failed: 0 };
    }
  }

  private async sendToUserOrThrow(
    userId: string,
    payload: { title: string; body: string; tag: string; url: string; type: string },
    options: { force?: boolean },
  ): Promise<PushSendResult> {
    if (!options.force && this.realtime.hasActiveConnection(userId)) {
      return { sent: 0, skipped: 'sse_active', failed: 0 };
    }
    if (!this.vapidConfigured) {
      this.logger.warn(`Push ignoré pour ${userId} (VAPID non configuré).`);
      return { sent: 0, skipped: 'vapid_not_configured', failed: 0 };
    }
    const subscriptions = await this.prisma.pushSubscription.findMany({
      where: { userId },
      select: { id: true, endpoint: true, p256dh: true, auth: true },
    });
    if (subscriptions.length === 0) {
      return { sent: 0, skipped: 'no_subscription', failed: 0 };
    }
    const body = JSON.stringify({
      title: payload.title,
      body: payload.body,
      icon: PUSH_ICON,
      badge: PUSH_ICON,
      tag: payload.tag,
      // `force: true` (push de test) : le Service Worker affiche TOUJOURS
      // (bypass anti-doublon SSE côté client). Absent sinon : l'anti-doublon
      // reste actif pour tous les pushs métier.
      ...(options.force ? { force: true } : {}),
      data: { url: payload.url, type: payload.type },
    });
    let sent = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
      try {
        await webPush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          body,
          { TTL: 24 * 60 * 60 },
        );
        sent += 1;
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        if (statusCode === 410 || statusCode === 404) {
          // Abonnement mort côté push service : suppression silencieuse.
          await this.prisma.pushSubscription
            .delete({ where: { id: subscription.id } })
            .catch(() => undefined);
        } else if (statusCode === 413) {
          this.logger.warn(`Push trop volumineux pour ${subscription.id} (413).`);
          failed += 1;
        } else {
          this.logger.warn(
            `Échec d'envoi push pour ${subscription.id} : ${
              error instanceof Error ? error.message : 'erreur inconnue'
            }.`,
          );
          failed += 1;
        }
      }
    }
    if (sent > 0) {
      await this.prisma.pushSubscription
        .updateMany({ where: { userId }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }
    return { sent, skipped: null, failed };
  }
}
