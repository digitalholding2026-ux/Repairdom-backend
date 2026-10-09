import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { RealtimeService } from '../realtime/realtime.service.js';
import { PushService } from '../push/push.service.js';
import { EmailService } from '../auth/email.service.js';
import { createNotification } from '../mission-events/mission-events.js';
import { buildNotificationMetadata } from '../notifications/notification-metadata.js';
import {
  REFERRAL_REWARD_XAF,
  REFERRAL_WELCOME_XAF,
} from './referrals.config.js';

/**
 * Chantier 4B — Notifications de parrainage, 4 canaux.
 *
 * Deux notifications distinctes, et non une template paramétrée :
 *
 *   `notifyReferrerRewarded` — le PARRAIN est crédité. C'est une ACTION :
 *     il peut consulter ses parrainages et en inviter d'autres. Le prestige
 *     est ici l'incitation, pas la somme.
 *   `notifyReferredRewarded` — le FILLEUL reçoit son bonus. C'est une
 *     information : rien ne lui est demandé ensuite.
 *
 * RÈGLE FCFA (inchangée) : `title` et `message` ne contiennent AUCUN montant
 * formaté ; le montant est un ENTIER XAF dans `metadata`, formaté à
 * l'affichage par `formatFCFA`. Un montant pré-formaté en base serait figé
 * pour tous les utilisateurs.
 *
 * AUCUN canal ne lève : la récompense est déjà créditée au ledger quand on
 * arrive ici, un e-mail en échec ne doit jamais faire perdre cet argent ni
 * faire échouer la confirmation de mission.
 *
 * Les canaux externes sont OPTIONNELS au sens TypeScript (`?`) : les tests
 * n'instancient que le minimum, et un module peut être monté sans push ni
 * e-mail configuré.
 */

const REFERRALS_PATH = '/client/parrainage';
const BALANCE_PATH = '/client/solde';

@Injectable()
export class ReferralsNotificationsService {
  private readonly logger = new Logger(ReferralsNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime?: RealtimeService,
    private readonly push?: PushService,
    private readonly email?: EmailService,
    private readonly config?: ConfigService,
  ) {}

  /**
   * Parrain : une filleul a confirmé sa première intervention, la récompense
   * est créditée. `referredName` est le prénom connu du filleul — jamais son
   * e-mail, qui ne doit pas être exposé dans une notification lisible sur un
   * téléphone partagé.
   */
  async notifyReferrerRewarded(
    referrerId: string,
    referredName: string,
  ): Promise<void> {
    const title = '🎁 Vous avez reçu votre récompense de parrainage !';
    const message =
      'Un filleul a validé sa première intervention. Votre crédit est disponible sur votre solde.';

    let notificationId: string | null = null;
    try {
      const created = await this.prisma.$transaction((tx) =>
        createNotification(tx, {
          userId: referrerId,
          /* `demandeId` null : ce n'est pas une notification de mission, donc
           * l'app ne la regroupe pas sous une mission (même choix que
           * `KYC_VERIFIED`). */
          demandeId: null,
          type: 'REFERRAL_REWARDED',
          title,
          message,
          metadata: buildNotificationMetadata({
            referralRewardXAF: REFERRAL_REWARD_XAF,
            referralReferredName: referredName,
            referralAction: 'view_referrals',
          }),
        }),
      );
      notificationId = created.id;
    } catch (error) {
      this.logChannelFailure('notification in-app', referrerId, error);
    }

    // ── Canal 2/4 : SSE ──
    if (this.realtime) {
      try {
        if (notificationId) {
          this.realtime.publishToUser(referrerId, 'notification.created', {
            notificationId,
            kind: 'REFERRAL_REWARDED',
          });
        }
        /* Permet à `/client/parrainage` de se rafraîchir sans rechargement. */
        this.realtime.publishToUser(referrerId, 'client.referrals_updated', {
          rewarded: true,
        });
      } catch (error) {
        this.logChannelFailure('SSE', referrerId, error);
      }
    }

    // ── Canal 3/4 : push web VAPID ──
    if (this.push) {
      try {
        await this.push.sendToUser(referrerId, {
          title: 'Récompense de parrainage reçue',
          body: `Un filleul a validé sa première intervention. ${REFERRAL_REWARD_XAF} FCFA crédités sur votre solde.`,
          tag: 'referral-rewarded',
          url: REFERRALS_PATH,
          type: 'referral_rewarded',
        });
      } catch (error) {
        this.logChannelFailure('push', referrerId, error);
      }
    }

    // ── Canal 4/4 : e-mail (Resend) ──
    if (this.email) {
      try {
        const to = await this.recipient(referrerId);
        if (to) {
          await this.email.sendReferralRewardedEmail(
            to,
            await this.recipientFirstName(referrerId),
            referredName,
            REFERRAL_REWARD_XAF,
            `${this.frontendUrl()}${REFERRALS_PATH}`,
          );
        }
      } catch (error) {
        this.logChannelFailure('e-mail', referrerId, error);
      }
    }
  }

  /**
   * Filleul : son bonus de bienvenue est crédité.
   *
   * Pas de nom de filleul dans le message : le filleul ne connaît pas
   * forcément son parrain nominativement, et l'annoncer n'apporterait rien.
   */
  async notifyReferredRewarded(referredId: string): Promise<void> {
    const title = '🎁 Bonus de bienvenue crédité';
    const message =
      'Votre crédit de bienvenue est disponible sur votre solde Relio.';

    let notificationId: string | null = null;
    try {
      const created = await this.prisma.$transaction((tx) =>
        createNotification(tx, {
          userId: referredId,
          demandeId: null,
          type: 'REFERRAL_WELCOME',
          title,
          message,
          metadata: buildNotificationMetadata({
            referralWelcomeXAF: REFERRAL_WELCOME_XAF,
            referralAction: 'view_balance',
          }),
        }),
      );
      notificationId = created.id;
    } catch (error) {
      this.logChannelFailure('notification in-app', referredId, error);
    }

    if (this.realtime) {
      try {
        if (notificationId) {
          this.realtime.publishToUser(referredId, 'notification.created', {
            notificationId,
            kind: 'REFERRAL_WELCOME',
          });
        }
      } catch (error) {
        this.logChannelFailure('SSE', referredId, error);
      }
    }

    if (this.push) {
      try {
        await this.push.sendToUser(referredId, {
          title: 'Bonus de bienvenue crédité',
          body: `${REFERRAL_WELCOME_XAF} FCFA viennent d'être ajoutés à votre solde Relio.`,
          tag: 'referral-welcome',
          url: BALANCE_PATH,
          type: 'referral_welcome',
        });
      } catch (error) {
        this.logChannelFailure('push', referredId, error);
      }
    }

    if (this.email) {
      try {
        const to = await this.recipient(referredId);
        if (to) {
          await this.email.sendReferralWelcomeEmail(
            to,
            await this.recipientFirstName(referredId),
            REFERRAL_WELCOME_XAF,
            `${this.frontendUrl()}${BALANCE_PATH}`,
          );
        }
      } catch (error) {
        this.logChannelFailure('e-mail', referredId, error);
      }
    }
  }

  /** Adresse e-mail du compte, ou `''` si l'envoi n'a pas lieu d'être. */
  private async recipient(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { email: true },
    });
    return user?.email ?? '';
  }

  private async recipientFirstName(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true },
    });
    return user?.firstName ?? '';
  }

  /** Base publique du frontend (repli identique aux autres services). */
  private frontendUrl(): string {
    const configured = this.config?.get<string>('FRONTEND_URL')?.trim().replace(/\/+$/, '');
    return configured || 'https://relioo.space';
  }

  /**
   * Journalise l'échec d'un canal.
   *
   * Aucun montant en clair dans le log : les journaux ne sont pas le support
   * d'un audit comptable, et le ledger est déjà écrit. Seul l'identifiant
   * technique et le nom du canal sont journalisés.
   */
  private logChannelFailure(channel: string, userId: string, error: unknown): void {
    this.logger.warn(
      `Canal « ${channel} » en échec pour ${userId} : ${
        error instanceof Error ? error.message : 'erreur inconnue'
      }. La récompense reste créditée au solde.`,
    );
  }
}