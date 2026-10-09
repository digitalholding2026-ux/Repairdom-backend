import { describe, expect, it, vi } from 'vitest';
import { ReferralsNotificationsService } from './referrals-notifications.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { PushService } from '../push/push.service.js';
import type { EmailService } from '../auth/email.service.js';
import type { ConfigService } from '@nestjs/config';
import {
  REFERRAL_REWARD_XAF,
  REFERRAL_WELCOME_XAF,
} from './referrals.config.js';

/* Chantier 4B — Notifications de parrainage, 4 canaux.
 *
 * Le contrat le plus important n'est pas « la notification part » mais :
 * AUCUN CANAL NE FAIT ÉCHOUER LES AUTRES, ni l'appelant. La récompense est
 * déjà créditée au ledger quand ces canaux s'exécutent ; un e-mail en échec ne
 * doit pas faire perdre cet argent.
 *
 * Prisma mocké sur des Maps, aucun réseau, aucune base. */

type Row = Record<string, any>;

const USERS = {
  referrer: { firstName: 'Awa', email: 'awa@test.cm' },
  referred: { firstName: 'Bobi', email: 'bobi@test.cm' },
};

function harness(options: {
  users?: Record<string, Row>;
  breakInApp?: boolean;
} = {}) {
  const users = new Map<string, Row>(
    Object.entries(options.users ?? USERS).map(([id, u]) => [id, { id, ...u }]),
  );
  const notifications: Row[] = [];
  let seq = 0;

  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where, select }: Row) => {
        const user = users.get(where.id);
        if (!user) return null;
        return Object.fromEntries(
          Object.keys(select ?? {}).map((k) => [k, user[k]]),
        );
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      if (options.breakInApp) throw new Error('base injoignable');
      return fn({
        notification: {
          create: vi.fn(async ({ data }: Row) => {
            seq += 1;
            const row = { id: `n-${seq}`, ...data };
            notifications.push(row);
            return row;
          }),
        },
      });
    }),
  };

  const realtime = { publishToUser: vi.fn() };
  const push = { sendToUser: vi.fn(async () => undefined) };
  const email = {
    sendReferralRewardedEmail: vi.fn(async () => undefined),
    sendReferralWelcomeEmail: vi.fn(async () => undefined),
  };
  const config = {
    get: vi.fn((key: string) =>
      key === 'FRONTEND_URL' ? 'https://relioo.space/' : undefined,
    ),
  };

  const service = new ReferralsNotificationsService(
    prisma as unknown as PrismaService,
    realtime as unknown as RealtimeService,
    push as unknown as PushService,
    email as unknown as EmailService,
    config as unknown as ConfigService,
  );

  return { service, prisma, realtime, push, email, notifications };
}

describe('ReferralsNotificationsService — 4 canaux', () => {
  it('parrain : notifie in-app, SSE, push ET e-mail', async () => {
    const h = harness();
    await h.service.notifyReferrerRewarded('referrer', 'Bobi K.');

    /* Canal 1 : in-app. */
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]).toMatchObject({
      userId: 'referrer',
      type: 'REFERRAL_REWARDED',
    });
    /* Montant en ENTIER dans les métadonnées, jamais formaté dans le texte. */
    expect(h.notifications[0]!.metadata.referralRewardXAF).toBe(REFERRAL_REWARD_XAF);
    expect(h.notifications[0]!.title).not.toContain('FCFA');
    expect(h.notifications[0]!.message).not.toContain('FCFA');
    /* Ce n'est pas une notification de mission : pas de regroupement. */
    expect(h.notifications[0]!.demandeId).toBeNull();
    /* Le prénom du filleul, jamais son e-mail. */
    expect(h.notifications[0]!.metadata.referralReferredName).toBe('Bobi K.');
    expect(JSON.stringify(h.notifications[0])).not.toContain('bobi@test.cm');

    /* Canal 2 : SSE. */
    expect(h.realtime.publishToUser).toHaveBeenCalledWith(
      'referrer',
      'notification.created',
      expect.objectContaining({ kind: 'REFERRAL_REWARDED' }),
    );
    expect(h.realtime.publishToUser).toHaveBeenCalledWith(
      'referrer',
      'client.referrals_updated',
      expect.anything(),
    );

    /* Canal 3 : push vers la page parrainage. */
    expect(h.push.sendToUser).toHaveBeenCalledWith(
      'referrer',
      expect.objectContaining({ url: '/client/parrainage' }),
    );

    /* Canal 4 : e-mail. */
    expect(h.email.sendReferralRewardedEmail).toHaveBeenCalledWith(
      'awa@test.cm',
      'Awa',
      'Bobi K.',
      REFERRAL_REWARD_XAF,
      'https://relioo.space/client/parrainage',
    );
  });

  it('filleul : notifie in-app, SSE, push ET e-mail, vers son solde', async () => {
    const h = harness();
    await h.service.notifyReferredRewarded('referred');

    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]).toMatchObject({
      userId: 'referred',
      type: 'REFERRAL_WELCOME',
    });
    expect(h.notifications[0]!.metadata.referralWelcomeXAF).toBe(REFERRAL_WELCOME_XAF);
    /* Le filleul n'a pas de filleul à nommer. */
    expect(h.notifications[0]!.metadata.referralReferredName).toBeUndefined();

    expect(h.realtime.publishToUser).toHaveBeenCalledWith(
      'referred',
      'notification.created',
      expect.objectContaining({ kind: 'REFERRAL_WELCOME' }),
    );
    expect(h.push.sendToUser).toHaveBeenCalledWith(
      'referred',
      expect.objectContaining({ url: '/client/solde' }),
    );
    expect(h.email.sendReferralWelcomeEmail).toHaveBeenCalledWith(
      'bobi@test.cm',
      'Bobi',
      REFERRAL_WELCOME_XAF,
      'https://relioo.space/client/solde',
    );
  });

  it('la base en échec n\'empêche ni le push ni l\'e-mail', async () => {
    /* La récompense est DÉJÀ créditée : la notifier est un confort. */
    const h = harness({ breakInApp: true });
    await expect(h.service.notifyReferrerRewarded('referrer', 'Bobi')).resolves.toBeUndefined();

    expect(h.notifications).toHaveLength(0);
    expect(h.push.sendToUser).toHaveBeenCalled();
    expect(h.email.sendReferralRewardedEmail).toHaveBeenCalled();
    /* Sans identifiant de notification, pas d'évènement SSE `notification.created`. */
    expect(h.realtime.publishToUser).not.toHaveBeenCalledWith(
      'referrer',
      'notification.created',
      expect.anything(),
    );
  });

  it('un push en échec n\'empêche pas l\'e-mail', async () => {
    const h = harness();
    h.push.sendToUser.mockRejectedValue(new Error('VAPID invalide'));
    await expect(h.service.notifyReferredRewarded('referred')).resolves.toBeUndefined();
    expect(h.email.sendReferralWelcomeEmail).toHaveBeenCalled();
  });

  it('un e-mail en échec ne fait pas échouer l\'appel', async () => {
    const h = harness();
    h.email.sendReferralRewardedEmail.mockRejectedValue(new Error('Resend 500'));
    await expect(h.service.notifyReferrerRewarded('referrer', 'Bobi')).resolves.toBeUndefined();
    expect(h.notifications).toHaveLength(1);
  });

  it('un compte sans e-mail : pas d\'e-mail, les autres canaux partent', async () => {
    const h = harness({ users: { referrer: { firstName: 'Awa', email: null } } });
    await h.service.notifyReferrerRewarded('referrer', 'Bobi');
    expect(h.email.sendReferralRewardedEmail).not.toHaveBeenCalled();
    expect(h.push.sendToUser).toHaveBeenCalled();
  });

  it('FRONTEND_URL malformé (barre finale) → lien propre', async () => {
    const h = harness();
    await h.service.notifyReferrerRewarded('referrer', 'Bobi');
    expect(h.email.sendReferralRewardedEmail).toHaveBeenCalledWith(
      'awa@test.cm',
      'Awa',
      'Bobi',
      REFERRAL_REWARD_XAF,
      'https://relioo.space/client/parrainage',
    );
  });

  it('fonctionne sans SSE, sans push et sans e-mail configurés', async () => {
    /* Montage partiel : le service ne doit lever sur aucun de ces
     * fournisseurs absents. */
    const base = harness();
    const prisma = base.prisma;
    const service = new ReferralsNotificationsService(
      prisma as unknown as PrismaService,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    await expect(service.notifyReferrerRewarded('referrer', 'Bobi')).resolves.toBeUndefined();
    expect(base.notifications).toHaveLength(1);
  });
});
