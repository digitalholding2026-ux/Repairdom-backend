import { describe, expect, it, vi } from 'vitest';
import { RewardsNotificationsService, REWARDS_PATH } from './rewards-notifications.service.js';
import { buildNotificationMetadata } from '../notifications/notification-metadata.js';
import { REWARD_TIER_BY_NAME } from './rewards.config.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ConfigService } from '@nestjs/config';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { PushService } from '../push/push.service.js';
import type { EmailService } from '../auth/email.service.js';

/* Chantier #4A — les 4 CANAUX de notification d'un palier atteint.
 *
 * Chaque canal est vérifié pour lui-même, et surtout pour son ISOLEMENT : un
 * canal en panne ne doit ni faire échouer les autres, ni faire échouer
 * l'appelant (le compteur de récompenses est déjà écrit à ce stade). */

type Row = Record<string, any>;

function harness(options: { email?: string | null } = {}) {
  const created: Row[] = [];
  const prisma = {
    /* `createNotification` passe par `$transaction`, avec `notification.create`
     * qui doit retourner `{ id }`. */
    $transaction: async (fn: (tx: Row) => Promise<Row>) =>
      fn({
        notification: {
          create: async ({ data }: Row) => {
            created.push(data);
            return { id: `n${created.length}` };
          },
        },
      }),
    user: {
      findUnique: async () => ({ email: options.email === undefined ? 'awa@test.cm' : options.email }),
    },
  } as unknown as PrismaService;

  const realtime = {
    publishToUser: vi.fn(),
    hasActiveConnection: vi.fn(() => false),
  } as unknown as RealtimeService & { publishToUser: ReturnType<typeof vi.fn> };

  const push = {
    sendToUser: vi.fn().mockResolvedValue({ sent: 1, skipped: null, failed: 0 }),
  } as unknown as PushService & { sendToUser: ReturnType<typeof vi.fn> };

  const email = {
    sendRewardTierReachedEmail: vi.fn().mockResolvedValue(undefined),
  } as unknown as EmailService & { sendRewardTierReachedEmail: ReturnType<typeof vi.fn> };

  const config = { get: (key: string) => (key === 'FRONTEND_URL' ? 'https://relioo.space' : undefined) } as ConfigService;

  const service = new RewardsNotificationsService(prisma, realtime, push, email, config);
  return { service, created, realtime, push, email };
}

const BRONZE = REWARD_TIER_BY_NAME.BRONZE;

describe('RewardsNotificationsService — 4 canaux', () => {
  it('canal 1 : crée la notification in-app avec metadata conforme', async () => {
    const h = harness();
    await h.service.notifyTierReached('c1', 'Awa', BRONZE, { label: 'Argent', remaining: 35 });

    expect(h.created).toHaveLength(1);
    const row = h.created[0];
    expect(row.userId).toBe('c1');
    /* Pas de mission rattachée : l'app affiche la notification à plat. */
    expect(row.demandeId).toBeNull();
    expect(row.type).toBe('REWARD_TIER_REACHED');
    expect(row.title).toBe('Palier Bronze atteint !');
    expect(row.message).toBe('Vous avez débloqué : Réduction sur votre prochaine mission');
    expect(row.metadata).toEqual({
      rewardTier: 'BRONZE',
      rewardLabel: 'Bronze',
      rewardMissions: 15,
      rewardValueXAF: 5_000,
      rewardAction: 'view_rewards',
    });
  });

  it('respecte la RÈGLE FCFA : aucun montant formaté dans title/message', async () => {
    const h = harness();
    await h.service.notifyTierReached('c1', 'Awa', BRONZE, null);

    const row = h.created[0];
    expect(row.title).not.toMatch(/FCFA/);
    expect(row.message).not.toMatch(/FCFA/);
    /* La valeur, elle, est bien un entier XAF dans metadata. */
    expect(Number.isInteger(row.metadata.rewardValueXAF)).toBe(true);
  });

  it('canal 2 : publie le SSE notification.created ET rewards_updated', async () => {
    const h = harness();
    await h.service.notifyTierReached('c1', 'Awa', BRONZE, null);

    expect(h.realtime.publishToUser).toHaveBeenCalledWith('c1', 'notification.created', {
      notificationId: 'n1',
      kind: 'REWARD_TIER_REACHED',
    });
    /* `client.rewards_updated` permet à `/client/recompenses` de se
     * rafraîchir sans rechargement de page. */
    expect(h.realtime.publishToUser).toHaveBeenCalledWith('c1', 'client.rewards_updated', {
      tierReached: 'BRONZE',
    });
  });

  it('canal 3 : envoie un push VAPID vers /client/recompenses', async () => {
    const h = harness();
    await h.service.notifyTierReached('c1', 'Awa', BRONZE, null);

    expect(h.push.sendToUser).toHaveBeenCalledWith('c1', {
      title: 'Palier Bronze atteint !',
      body: 'Vous avez débloqué : Réduction sur votre prochaine mission',
      tag: 'reward-BRONZE',
      url: REWARDS_PATH,
      type: 'reward_tier_reached',
    });
    expect(REWARDS_PATH).toBe('/client/recompenses');
  });

  it('canal 4 : envoie l’e-mail avec le lien du frontend et le palier suivant', async () => {
    const h = harness();
    await h.service.notifyTierReached('c1', 'Awa', BRONZE, { label: 'Argent', remaining: 35 });

    expect(h.email.sendRewardTierReachedEmail).toHaveBeenCalledWith(
      'awa@test.cm',
      'Awa',
      'Bronze',
      'Réduction sur votre prochaine mission',
      'https://relioo.space/client/recompenses',
      { label: 'Argent', remaining: 35 },
    );
  });

  it('omet l’e-mail quand le compte n’a pas d’adresse', async () => {
    const h = harness({ email: null });
    await h.service.notifyTierReached('c1', 'Awa', BRONZE, null);

    /* Les 3 autres canaux sont bien passés. */
    expect(h.created).toHaveLength(1);
    expect(h.push.sendToUser).toHaveBeenCalledTimes(1);
  });

  it('repli sur le domaine par défaut si FRONTEND_URL est absente', async () => {
    const created: Row[] = [];
    const prisma = {
      $transaction: async (fn: (tx: Row) => Promise<Row>) =>
        fn({ notification: { create: async ({ data }: Row) => { created.push(data); return { id: 'n1' }; } } }),
      user: { findUnique: async () => ({ email: 'a@b.cm' }) },
    } as unknown as PrismaService;
    const email = { sendRewardTierReachedEmail: vi.fn() } as unknown as EmailService;
    const service = new RewardsNotificationsService(
      prisma,
      undefined,
      undefined,
      email,
      { get: () => undefined } as unknown as ConfigService,
    );

    await service.notifyTierReached('c1', 'Awa', BRONZE, null);

    /* Un lien relatif dans un e-mail ne serait pas cliquable. */
    expect(email.sendRewardTierReachedEmail).toHaveBeenCalledWith(
      'a@b.cm', 'Awa', 'Bronze', expect.any(String),
      'https://relioo.space/client/recompenses', null,
    );
  });
});

describe('RewardsNotificationsService — isolation des pannes de canal', () => {
  it('un push en échec n’empêche ni l’in-app, ni le SSE, ni l’e-mail', async () => {
    const h = harness();
    (h.push.sendToUser as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('VAPID invalide'));

    await expect(h.service.notifyTierReached('c1', 'Awa', BRONZE, null)).resolves.toBeUndefined();

    expect(h.created).toHaveLength(1);
    expect(h.realtime.publishToUser).toHaveBeenCalled();
    expect(h.email.sendRewardTierReachedEmail).toHaveBeenCalled();
  });

  it('une notification in-app en échec n’empêche pas les 3 autres canaux', async () => {
    const h = harness();
    const prisma = {
      $transaction: async () => {
        throw new Error('in-app indisponible');
      },
      user: { findUnique: async () => ({ email: 'a@b.cm' }) },
    } as unknown as PrismaService;
    const service = new RewardsNotificationsService(
      prisma, h.realtime, h.push, h.email, { get: () => undefined } as unknown as ConfigService,
    );

    await expect(service.notifyTierReached('c1', 'Awa', BRONZE, null)).resolves.toBeUndefined();

    /* Pas de `notificationId`, mais le push et l'e-mail partent quand même. */
    expect(h.push.sendToUser).toHaveBeenCalledTimes(1);
    expect(h.email.sendRewardTierReachedEmail).toHaveBeenCalledTimes(1);
    expect(h.realtime.publishToUser).toHaveBeenCalledWith('c1', 'client.rewards_updated', {
      tierReached: 'BRONZE',
    });
  });

  it('fonctionne SANS les canaux optionnels (tests unitaires, env minimal)', async () => {
    const created: Row[] = [];
    const prisma = {
      $transaction: async (fn: (tx: Row) => Promise<Row>) =>
        fn({ notification: { create: async ({ data }: Row) => { created.push(data); return { id: 'n1' }; } } }),
    } as unknown as PrismaService;
    const service = new RewardsNotificationsService(prisma);

    await expect(service.notifyTierReached('c1', 'Awa', BRONZE, null)).resolves.toBeUndefined();
    expect(created).toHaveLength(1);
  });
});

describe('RewardsNotificationsService — mission écartée', () => {
  it('notifie sur 3 canaux et JAMAIS d’e-mail', async () => {
    const h = harness();
    await h.service.notifyMissionNotCounted('c1', 'SAME_TECHNICIAN_48H', 'RD-BBB222');

    expect(h.created[0]).toEqual(
      expect.objectContaining({
        userId: 'c1',
        demandeId: null,
        type: 'REWARD_MISSION_NOT_COUNTED',
        title: 'Mission non comptabilisée',
        metadata: { rewardFraudReason: 'SAME_TECHNICIAN_48H', rewardAction: 'contact_support' },
      }),
    );
    expect(h.push.sendToUser).toHaveBeenCalledTimes(1);
    /* Une décision administrative ne s'envoie pas par e-mail : c'est
     * volontairement plus sobre. */
    expect(h.email.sendRewardTierReachedEmail).not.toHaveBeenCalled();
    expect(h.realtime.publishToUser).toHaveBeenCalledWith('c1', 'client.rewards_updated', {
      missionReference: 'RD-BBB222',
      counted: false,
    });
  });

  it('n’expose jamais le commentaire libre de l’admin au client', async () => {
    const h = harness();
    await h.service.notifyMissionNotCounted('c1', 'SAME_TECHNICIAN_48H', 'RD-BBB222');

    /* Le `note` de l'admin n'est même pas un paramètre de cette méthode : il
     * n'a aucun chemin vers le client. */
    expect(JSON.stringify(h.created[0])).not.toMatch(/note/);
  });
});

describe('buildNotificationMetadata — clés récompenses', () => {
  it('accepte les nouvelles clés et écarte les valeurs undefined/null', () => {
    expect(
      buildNotificationMetadata({
        rewardTier: 'BRONZE',
        rewardLabel: null,
        rewardMissions: 15,
        rewardValueXAF: 5_000,
        rewardAction: 'view_rewards',
      }),
    ).toEqual({
      rewardTier: 'BRONZE',
      rewardMissions: 15,
      rewardValueXAF: 5_000,
      rewardAction: 'view_rewards',
    });
  });

  it('écarte une clé inconnue (le filtre est réel, pas seulement typé)', () => {
    expect(
      buildNotificationMetadata({ rewardTier: 'OR', hacked: 'x' } as never),
    ).toEqual({ rewardTier: 'OR' });
  });
});
