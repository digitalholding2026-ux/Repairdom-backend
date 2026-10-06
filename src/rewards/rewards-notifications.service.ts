import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { PushService } from '../push/push.service.js';
import { EmailService } from '../auth/email.service.js';
import { createNotification } from '../mission-events/mission-events.js';
import { buildNotificationMetadata } from '../notifications/notification-metadata.js';
import type { RewardTierDefinition } from './rewards.config.js';

/**
 * Chantier #4A — diffusion du programme de récompenses sur les 4 canaux.
 *
 * Isolé dans son propre service (plutôt que noyé dans `RewardsService`) pour
 * deux raisons :
 *   1. les canaux de notification ont chacun leur propre politique d'échec
 *      (in-app transactionnel, SSE infallible en pratique, push déjà
 *      encapsulé, e-mail tolérant) — ces politiques se lisent d'un bloc ;
 *   2. `RewardsService` reste testable sans instancier 4 dépendances.
 *
 * RÈGLE FCFA : `title` et `message` sont des textes GÉNÉRIQUES. Aucun montant
 * n'y apparaît : `rewardValueXAF` est un entier dans `metadata`, formaté par
 * `formatFCFA` côté frontend.
 *
 * AUCUN canal ne bloque ni ne fait échouer l'appelant : chaque canal est
 * encapsulé dans son propre try/catch et journalisé. Un client qui ne peut pas
 * être notifié ne doit jamais faire échouer une confirmation de mission.
 */

/** Route publique du programme de récompenses (utilisée dans les liens). */
export const REWARDS_PATH = '/client/recompenses';

@Injectable()
export class RewardsNotificationsService {
  private readonly logger = new Logger(RewardsNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    /* Les 3 canaux externes + ConfigService sont OPTIONNELS au sens
     * TypeScript (`?`) afin que les tests unitaires puissent n'instancier que
     * le minimum. Même convention que `AdminService` (chantier #5A) : côté
     * Nest la résolution est effective, `RewardsModule` importe explicitement
     * `RealtimeModule`, `PushModule`, `AuthModule` (pour `EmailService`) et
     * `ConfigModule` est global. */
    private readonly realtime?: RealtimeService,
    private readonly push?: PushService,
    private readonly email?: EmailService,
    private readonly config?: ConfigService,
  ) {}

  /* ── Canal 1/4 : in-app ─────────────────────────────────────────── */

  /**
   * Notification « palier franchi ». `demandeId` reste `null` : ce n'est pas
   * une notification de mission, donc l'app ne la regroupe pas sous une
   * mission (même choix que `KYC_VERIFIED`).
   */
  async notifyTierReached(
    userId: string,
    firstName: string | null,
    tier: RewardTierDefinition,
    nextTier: { label: string; remaining: number } | null,
  ): Promise<void> {
    const title = `Palier ${tier.label} atteint !`;
    const message = `Vous avez débloqué : ${tier.reward}`;

    let notificationId: string | null = null;
    try {
      const created = await this.prisma.$transaction((tx) =>
        createNotification(tx, {
          userId,
          demandeId: null,
          type: 'REWARD_TIER_REACHED',
          title,
          message,
          metadata: buildNotificationMetadata({
            rewardTier: tier.tier,
            rewardLabel: tier.label,
            rewardMissions: tier.missions,
            rewardValueXAF: tier.rewardValueXAF,
            rewardAction: 'view_rewards',
          }),
        }),
      );
      notificationId = created.id;
    } catch (error) {
      this.logChannelFailure('notification in-app', userId, error);
    }

    // ── Canal 2/4 : SSE ──
    this.publishTierReached(userId, notificationId, tier.tier);

    // ── Canal 3/4 : push web VAPID ──
    if (this.push) {
      try {
        /* `sendToUser` ne lève jamais et SUPPRIME l'envoi si une connexion
         * SSE est active : c'est voulu, pas de doublon. `tag` par palier : un
         * push de palier écrase le précédent du même palier. */
        await this.push.sendToUser(userId, {
          title: `Palier ${tier.label} atteint !`,
          body: `Vous avez débloqué : ${tier.reward}`,
          tag: `reward-${tier.tier}`,
          url: REWARDS_PATH,
          type: 'reward_tier_reached',
        });
      } catch (error) {
        this.logChannelFailure('push', userId, error);
      }
    }

    // ── Canal 4/4 : e-mail (Resend) ──
    if (this.email) {
      const base = this.frontendUrl();
      try {
        await this.email.sendRewardTierReachedEmail(
          /* L'e-mail part vers l'adresse du compte ; `firstName` sert au
           * ton personalization. Sans e-mail connu, rien à envoyer. */
          await this.recipientEmail(userId),
          firstName ?? '',
          tier.label,
          tier.reward,
          `${base}${REWARDS_PATH}`,
          nextTier ? { label: nextTier.label, remaining: nextTier.remaining } : null,
        );
      } catch (error) {
        this.logChannelFailure('e-mail', userId, error);
      }
    }
  }

  /* ── Mission écartée après décision anti-fraude ──────────────────── */

  /**
   * Notifie le client qu'une mission n'a pas été comptabilisée.
   *
   * VOLONTAIREMENT 3 canaux seulement (in-app + SSE + push, PAS d'e-mail) :
   * une décision administrative qui retire un point au client ne doit pas
   * saturer la boîte mail — même approche que le refus KYC côté technicien,
   * où l'in-app suffit. Le client ouvre `/client/recompenses` s'il veut
   * comprendre.
   */
  async notifyMissionNotCounted(
    userId: string,
    reason: string,
    missionReference: string,
  ): Promise<void> {
    let notificationId: string | null = null;
    try {
      const created = await this.prisma.$transaction((tx) =>
        createNotification(tx, {
          userId,
          demandeId: null,
          type: 'REWARD_MISSION_NOT_COUNTED',
          title: 'Mission non comptabilisée',
          message: `La mission ${missionReference} n'a pas été retenue dans votre programme de récompenses.`,
          metadata: buildNotificationMetadata({
            rewardFraudReason: reason,
            rewardAction: 'contact_support',
          }),
        }),
      );
      notificationId = created.id;
    } catch (error) {
      this.logChannelFailure('notification in-app', userId, error);
    }

    if (this.realtime) {
      try {
        if (notificationId) {
          this.realtime.publishToUser(userId, 'notification.created', {
            notificationId,
            kind: 'REWARD_MISSION_NOT_COUNTED',
          });
        }
        this.realtime.publishToUser(userId, 'client.rewards_updated', {
          missionReference,
          counted: false,
        });
      } catch (error) {
        this.logChannelFailure('SSE', userId, error);
      }
    }

    if (this.push) {
      try {
        await this.push.sendToUser(userId, {
          title: 'Mission non comptabilisée',
          body: `La mission ${missionReference} n'a pas été retenue dans vos récompenses.`,
          tag: 'reward-not-counted',
          url: REWARDS_PATH,
          type: 'reward_mission_not_counted',
        });
      } catch (error) {
        this.logChannelFailure('push', userId, error);
      }
    }
  }

  /**
   * Signal temps réel « la progression a changé ». Émis dans TOUS les cas
   * (palier franchi, mission comptée, mission écartée) : l'écran
   * `/client/recompenses` se rafraîchit sans rechargement.
   */
  publishProgressChanged(userId: string, payload: Record<string, unknown> = {}): void {
    if (!this.realtime) return;
    try {
      this.realtime.publishToUser(userId, 'client.rewards_updated', payload);
    } catch (error) {
      this.logChannelFailure('SSE', userId, error);
    }
  }

  private publishTierReached(userId: string, notificationId: string | null, tier: string): void {
    if (!this.realtime) return;
    try {
      if (notificationId) {
        this.realtime.publishToUser(userId, 'notification.created', {
          notificationId,
          kind: 'REWARD_TIER_REACHED',
        });
      }
      this.realtime.publishToUser(userId, 'client.rewards_updated', { tierReached: tier });
    } catch (error) {
      this.logChannelFailure('SSE', userId, error);
    }
  }

  /** Adresse e-mail du compte, ou `''` si l'envoi n'a pas lieu d'être. */
  private async recipientEmail(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    return user?.email ?? '';
  }

  /** Base publique du frontend (repli identique à `EmailService` /
   *  `AdminService.frontendUrl`). */
  private frontendUrl(): string {
    const configured = this.config?.get<string>('FRONTEND_URL')?.trim().replace(/\/+$/, '');
    return configured || 'https://relioo.space';
  }

  /* Journalise l'échec d'un canal. Aucun secret, aucune donnée personnelle :
   * uniquement l'identifiant technique du client et le nom du canal. */
  private logChannelFailure(channel: string, userId: string, error: unknown): void {
    this.logger.warn(
      `Canal « ${channel} » en échec pour ${userId} : ${
        error instanceof Error ? error.message : 'erreur inconnue'
      }. La progression des récompenses est conservée.`,
    );
  }
}
