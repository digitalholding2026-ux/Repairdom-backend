import { describe, expect, it, vi } from 'vitest';

vi.mock('web-push', () => {
  const fns = {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(async () => undefined),
  };
  return { ...fns, default: fns };
});

import * as webPush from 'web-push';
import { PushController } from './push.controller.js';
import { PushService } from './push.service.js';

/* Push web VAPID : abonnements, skip SSE, envois, nettoyage 410/404.
 * `web-push` mocké (aucun envoi réel), Prisma/Realtime simulés. */

type Row = Record<string, any>;

function setup(options: { sseActive: boolean; vapid: boolean } = { sseActive: false, vapid: true }) {
  const store = new Map<string, Row>();
  const prisma = {
    pushSubscription: {
      upsert: vi.fn(async ({ where, create, update }: any) => {
        for (const row of store.values()) {
          if (row.endpoint === where.endpoint) {
            Object.assign(row, update);
            return { ...row };
          }
        }
        const row = { id: `ps-${store.size + 1}`, createdAt: new Date(), ...create };
        store.set(row.id, row);
        return { ...row };
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        let count = 0;
        for (const [id, row] of store.entries()) {
          if (row.userId === where.userId && (!where.endpoint || row.endpoint === where.endpoint)) {
            store.delete(id);
            count += 1;
          }
        }
        return { count };
      }),
      delete: vi.fn(async ({ where }: any) => {
        store.delete(where.id);
        return {};
      }),
      findMany: vi.fn(async ({ where }: any) => {
        return [...store.values()].filter((row) => row.userId === where.userId).map((row) => ({ ...row }));
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  };
  const config = {
    get: vi.fn((key: string) => {
      if (!options.vapid && (key === 'VAPID_PUBLIC_KEY' || key === 'VAPID_PRIVATE_KEY')) return undefined;
      const values: Record<string, string> = {
        VAPID_PUBLIC_KEY: 'BP_test_public_key',
        VAPID_PRIVATE_KEY: 'test_private_key',
        VAPID_SUBJECT: 'mailto:contact@relioo.space',
      };
      return values[key];
    }),
  };
  const realtime = { hasActiveConnection: vi.fn(() => options.sseActive) };
  const service = new PushService(prisma as never, config as never, realtime as never);
  return { service, prisma, config, realtime, store };
}

const SUBSCRIPTION = {
  endpoint: 'https://push.example.com/sub/1',
  keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
};

describe('registerSubscription — upsert par endpoint', () => {
  it('crée puis rejoue sans doublon (maj lastUsedAt)', async () => {
    const { service, store } = setup();
    const first = await service.registerSubscription('u-1', SUBSCRIPTION, 'UA/1.0');
    const second = await service.registerSubscription('u-1', { ...SUBSCRIPTION }, 'UA/2.0');
    expect(first.id).toBe(second.id);
    expect(store.size).toBe(1);
    expect([...store.values()][0]?.userAgent).toBe('UA/2.0');
  });
});

describe('unregisterSubscription — idempotent', () => {
  it('existant puis inexistant → ok sans crash', async () => {
    const { service } = setup();
    await service.registerSubscription('u-1', SUBSCRIPTION);
    await expect(service.unregisterSubscription('u-1', SUBSCRIPTION.endpoint)).resolves.toEqual({
      ok: true,
    });
    await expect(service.unregisterSubscription('u-1', SUBSCRIPTION.endpoint)).resolves.toEqual({
      ok: true,
    });
    // Abonnement d'un tiers : même réponse, ligne conservée.
    await service.registerSubscription('u-2', { ...SUBSCRIPTION, endpoint: 'https://x/y' });
    await expect(service.unregisterSubscription('u-1', 'https://x/y')).resolves.toEqual({
      ok: true,
    });
  });
});

describe('sendToUser', () => {
  it('skip si SSE actif (sauf force)', async () => {
    const { service } = setup({ sseActive: true, vapid: true });
    await service.registerSubscription('u-1', SUBSCRIPTION);
    await expect(
      service.sendToUser('u-1', { title: 'T', body: 'B', tag: 't', url: '/', type: 'x' }),
    ).resolves.toEqual({ sent: 0, skipped: 'sse_active', failed: 0 });
    expect(webPush.sendNotification).not.toHaveBeenCalled();
    await expect(
      service.sendToUser(
        'u-1',
        { title: 'T', body: 'B', tag: 't', url: '/', type: 'x' },
        { force: true },
      ),
    ).resolves.toMatchObject({ sent: 1 });
  });

  it('envoie si pas de SSE ; 410 → suppression silencieuse', async () => {
    const { service, store } = setup({ sseActive: false, vapid: true });
    await service.registerSubscription('u-1', SUBSCRIPTION);
    await service.registerSubscription('u-1', { ...SUBSCRIPTION, endpoint: 'https://push.example.com/sub/2' });
    vi.mocked(webPush.sendNotification).mockRejectedValueOnce(
      Object.assign(new Error('Gone'), { statusCode: 410 }),
    );
    const result = await service.sendToUser('u-1', {
      title: 'T',
      body: 'B',
      tag: 't',
      url: '/',
      type: 'x',
    });
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(store.size).toBe(1);
  });

  it('sans VAPID → skip propre, sans envoi', async () => {
    const { service } = setup({ sseActive: false, vapid: false });
    await expect(
      service.sendToUser('u-1', { title: 'T', body: 'B', tag: 't', url: '/', type: 'x' }),
    ).resolves.toEqual({ sent: 0, skipped: 'vapid_not_configured', failed: 0 });
  });
});

describe('PushController — auth et validation', () => {
  function controller() {
    const { service } = setup();
    return new PushController(service);
  }

  it('vapid-public-key public → clé exposée', () => {
    expect(controller().vapidPublicKey()).toEqual({ publicKey: 'BP_test_public_key' });
  });

  it('subscribe retourne 201 + { id }', async () => {
    const ctl = controller();
    const result = await ctl.subscribe(
      { id: 'u-1', email: 'a@b.c', role: 'CLIENT' } as never,
      { subscription: SUBSCRIPTION } as never,
      { headers: {} } as never,
    );
    expect(typeof result.id).toBe('string');
  });

  it('unsubscribe idempotent → 204 sans contenu', async () => {
    const ctl = controller();
    await expect(
      ctl.unsubscribe({ id: 'u-1', email: 'a@b.c', role: 'CLIENT' } as never, {
        endpoint: 'https://push.example.com/sub/1',
      }),
    ).resolves.toBeUndefined();
  });
});
