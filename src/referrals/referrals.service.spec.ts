import { describe, expect, it, vi } from 'vitest';
import { ReferralsService } from './referrals.service.js';
import {
  REFERRAL_MAX_REFERRALS,
  REFERRAL_REWARD_XAF,
  REFERRAL_WELCOME_XAF,
  generateReferralCode,
  isValidReferralCode,
  normalizeReferralCode,
} from './referrals.config.js';
import type { ReferralsNotificationsService } from './referrals-notifications.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { ConfigService } from '@nestjs/config';

/**
 * Chantier 4B — Parrainage client.
 *
 * On n'empile pas des `vi.fn()` : le double implémente le sous-ensemble de
 * requêtes réellement utilisées par `ReferralsService` sur des Maps, et
 * respecte les contraintes que la BASE impose — index unique sur `code` et sur
 * `referredId`, `updateMany` gardé sur le statut. Un double qui ignorerait
 * l'unicité rendrait les tests d'anti-abus greens à vide.
 *
 * Aucun accès réseau, aucune base : test unitaire pur.
 *
 * Les MONTANTS attendus viennent des VRAIES constantes de `referrals.config.ts` :
 * un test qui recalculerait 500 à la main ne prouverait rien.
 */

type Row = Record<string, any>;

function world(
  seed: {
    users?: Record<string, Row>;
    referrals?: Row[];
    ledger?: Row[];
  } = {},
) {
  const users = new Map<string, Row>(
    Object.entries(seed.users ?? {}).map(([id, u]) => [id, { id, ...u }]),
  );
  const referrals = new Map<string, Row>();
  const ledger = new Map<string, Row>();
  let seq = 0;
  for (const r of seed.referrals ?? []) {
    referrals.set(r.id, { ...r });
  }
  for (const t of seed.ledger ?? []) ledger.set(t.reference, { ...t });

  const violations: string[] = [];

  const prisma = {
    user: {
      findUnique: vi.fn(async (args: Row) => {
        /* Un seul `where` dans ce service : `id` ou `referralCode`. */
        const user = args.where?.id
          ? users.get(args.where.id)
          : [...users.values()].find((u) => u.referralCode === args.where?.referralCode);
        return user ? { ...user } : null;
      }),
      update: vi.fn(async (args: Row) => {
        const user = users.get(args.where.id);
        if (!user) throw new Error('user introuvable');
        if (
          args.data.referralCode &&
          [...users.values()].some(
            (u) => u.id !== user.id && u.referralCode === args.data.referralCode,
          )
        ) {
          /* La VRAIE base refuse : P2002 sur l'index unique. */
          const error = new Error('Unique constraint failed') as Error & { code?: string };
          error.code = 'P2002';
          throw error;
        }
        user.referralCode = args.data.referralCode;
        return { ...user };
      }),
    },
    referral: {
      findFirst: vi.fn(async (args: Row) => {
        const row = [...referrals.values()].find((r) => {
          if (args.where.referredId && r.referredId !== args.where.referredId) return false;
          if (args.where.referrerId && r.referrerId !== args.where.referrerId) return false;
          if (args.where.status && r.status !== args.where.status) return false;
          return true;
        });
        if (!row) return null;
        /* `include` sous forme de relations : le service demande
         * `referrer` et `referred` (noms seulement). */
        return {
          ...row,
          referrer: users.get(row.referrerId) ?? null,
          referred: row.referredId ? (users.get(row.referredId) ?? null) : null,
        };
      }),
      findUnique: vi.fn(async (args: Row) => {
        const row = [...referrals.values()].find((r) => {
          if (args.where?.referredId && r.referredId === args.where.referredId) return true;
          if (args.where?.id && r.id === args.where.id) return true;
          return false;
        });
        return row ? { ...row } : null;
      }),
      findMany: vi.fn(async (args: Row) => {
        return [...referrals.values()]
          .filter((r) => r.referrerId === args.where.referrerId)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
          .map((r) => ({ ...r, referred: r.referredId ? users.get(r.referredId) ?? null : null }));
      }),
      count: vi.fn(async (args: Row) => {
        const statuses: string[] = args.where?.status?.in ?? [];
        return [...referrals.values()].filter(
          (r) => r.referrerId === args.where?.referrerId && statuses.includes(r.status),
        ).length;
      }),
      create: vi.fn(async (args: Row) => {
        /* Unicité REALLE : deux parrainages pour le même filleul doivent
         * échouer comme en base. */
        if (
          args.data.referredId &&
          [...referrals.values()].some((r) => r.referredId === args.data.referredId)
        ) {
          const error = new Error('Unique constraint failed') as Error & { code?: string };
          error.code = 'P2002';
          violations.push('create');
          throw error;
        }
        if ([...referrals.values()].some((r) => r.code === args.data.code)) {
          const error = new Error('Unique constraint failed') as Error & { code?: string };
          error.code = 'P2002';
          violations.push('create');
          throw error;
        }
        seq += 1;
        /* Préfixe distinct des ids seedés : sinon une création peut
         * ÉCRASER une ligne existante dans la Map du double. */
        const row = {
          id: `ref-new-${seq}`,
          rewardedAt: null,
          createdAt: new Date('2026-10-09T10:00:00Z'),
          updatedAt: new Date('2026-10-09T10:00:00Z'),
          ...args.data,
        };
        referrals.set(row.id, row);
        return { ...row };
      }),
      updateMany: vi.fn(async (args: Row) => {
        const row = referrals.get(args.where.id);
        /* Le `where` gardé : si le statut lu a bougé, AUCUNE ligne n'est
         * touchée. C'est le verrou anti-double-versement. */
        if (!row || (args.where.status && row.status !== args.where.status)) {
          return { count: 0 };
        }
        Object.assign(row, args.data);
        return { count: 1 };
      }),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      return fn({
        financialTransaction: {
          create: vi.fn(async (args: Row) => {
            if (ledger.has(args.data.reference)) {
              const error = new Error('Unique constraint failed') as Error & { code?: string };
              error.code = 'P2002';
              throw error;
            }
            const row = { id: `ft-${ledger.size + 1}`, ...args.data };
            ledger.set(row.reference, row);
            return row;
          }),
        },
      });
    }),
  };

  const notifications = {
    notifyReferrerRewarded: vi.fn(async () => undefined),
    notifyReferredRewarded: vi.fn(async () => undefined),
  };
  const realtime = { publishToUser: vi.fn() };
  const config = {
    get: vi.fn((key: string) => (key === 'FRONTEND_URL' ? 'https://www.relioo.space' : 'REAL')),
  };

  const service = new ReferralsService(
    prisma as unknown as PrismaService,
    notifications as unknown as ReferralsNotificationsService,
    realtime as unknown as RealtimeService,
    config as unknown as ConfigService,
  );

  return { service, prisma, notifications, realtime, users, referrals, ledger, violations };
}

const USERS = {
  referrer: {
    firstName: 'Awa',
    lastName: 'N.',
    email: 'awa@test.cm',
    referralCode: 'RELIO-ABCDE',
  },
  referred: { firstName: 'Bobi', lastName: 'K.', email: 'bobi@test.cm' },
};

/* ── Génération de code ────────────────────────────────────────────────── */

describe('génération de code', () => {
  it('produit RELIO- suivi de 5 caractères de l’alphabet sans ambiguïtés', () => {
    for (let i = 0; i < 200; i += 1) {
      const code = generateReferralCode();
      expect(code).toMatch(/^RELIO-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/);
      expect(isValidReferralCode(code)).toBe(true);
      /* Les 5 caractères réellement exclus : « zéro ou O », « un ou I »,
       * « un ou L ». On teste le SUFFIXE : le préfixe contient
       * volontairement un « O » (« RELIO »). */
      const suffix = code.slice('RELIO-'.length);
      expect(suffix).not.toMatch(/[01ILO]/);
      expect(suffix).toHaveLength(5);
    }
  });

  it('génère des codes distincts (échantillon large)', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateReferralCode()));
    expect(codes.size).toBe(500);
  });

  it('valide la casse, les espaces et la longueur', () => {
    expect(isValidReferralCode('RELIO-ABCDE')).toBe(true);
    expect(isValidReferralCode(' relio-abcde ')).toBe(true);
    expect(isValidReferralCode('RELIO-ABCD')).toBe(false);
    expect(isValidReferralCode('RELIO-ABCDEF')).toBe(false);
    expect(isValidReferralCode('XXXXX-ABCDE')).toBe(false);
    expect(isValidReferralCode('RELIO-AB0DE')).toBe(false); // 0 interdit
    expect(isValidReferralCode(null)).toBe(false);
    expect(isValidReferralCode(undefined)).toBe(false);
    expect(isValidReferralCode('')).toBe(false);
  });

  it('normalise une saisie collée (casse, espaces, préfixe absent)', () => {
    expect(normalizeReferralCode('relio-abcde')).toBe('RELIO-ABCDE');
    expect(normalizeReferralCode('  relio-abcde  ')).toBe('RELIO-ABCDE');
    expect(normalizeReferralCode('abcde')).toBe('RELIO-ABCDE');
    expect(normalizeReferralCode('')).toBe(null);
    expect(normalizeReferralCode(undefined)).toBe(null);
  });
});

/* ── getOrCreateMyCode ─────────────────────────────────────────────────── */

describe('getOrCreateMyCode', () => {
  it('génère un code au premier appel et le persiste', async () => {
    const { service, users } = world({ users: { referred: USERS.referred } });
    const code = await service.getOrCreateMyCode('referred');
    expect(isValidReferralCode(code)).toBe(true);
    expect(users.get('referred')?.referralCode).toBe(code);
  });

  it('renvoie le MÊME code au 2ᵉ appel, sans regénérer', async () => {
    const { service, users, prisma } = world({ users: { referred: USERS.referred } });
    const first = await service.getOrCreateMyCode('referred');
    const updates = prisma.user.update.mock.calls.length;
    const second = await service.getOrCreateMyCode('referred');
    expect(second).toBe(first);
    expect(prisma.user.update.mock.calls.length).toBe(updates);
    expect(users.get('referred')?.referralCode).toBe(first);
  });

  it('ne touche pas un code déjà présent', async () => {
    const { service, prisma } = world({ users: { referrer: USERS.referrer } });
    expect(await service.getOrCreateMyCode('referrer')).toBe('RELIO-ABCDE');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('régénère après une collision (P2002 sur l’index unique)', async () => {
    const { service, prisma } = world({ users: { referred: USERS.referred } });
    /* La 1ʳᵉ tentative est refusée comme en base (code déjà pris), la 2ᵉ passe.
     * On teste la LOGIQUE de retry, pas le tirage aléatoire : forcer `Math.random`
     * pour reproduire un code précis serait tester le générateur, pas le service. */
    prisma.user.update
      .mockRejectedValueOnce(Object.assign(new Error('Unique'), { code: 'P2002' }))
      .mockImplementationOnce(async (args: Row) => {
        const user = { id: 'referred', referralCode: args.data.referralCode };
        return user;
      });
    const code = await service.getOrCreateMyCode('referred');
    expect(isValidReferralCode(code)).toBe(true);
    expect(prisma.user.update.mock.calls.length).toBe(2);
  });

  it('échoue proprement après 5 collisions plutôt que de boucler', async () => {
    const { service, prisma } = world({ users: { referred: USERS.referred } });
    prisma.user.update.mockRejectedValue(
      Object.assign(new Error('Unique'), { code: 'P2002' }),
    );
    await expect(service.getOrCreateMyCode('referred')).rejects.toThrow(
      /Impossible de générer/,
    );
    expect(prisma.user.update.mock.calls.length).toBe(5);
  });

  it('refuse un compte inexistant', async () => {
    const { service } = world();
    await expect(service.getOrCreateMyCode('fantome')).rejects.toThrow(/introuvable/i);
  });
});

/* ── registerReferral ──────────────────────────────────────────────────── */

describe('registerReferral : rattachement à l’inscription', () => {
  it('code valide → Referral créé en REGISTERED', async () => {
    const { service, referrals } = world({ users: { ...USERS } });
    const result = await service.registerReferral('referred', 'RELIO-ABCDE', 'bobi@test.cm');
    expect(result).toEqual({ success: true, referrerName: 'Awa' });
    expect(referrals.size).toBe(1);
    const row = [...referrals.values()][0]!;
    expect(row.status).toBe('REGISTERED');
    expect(row.referrerId).toBe('referrer');
    expect(row.referredId).toBe('referred');
    expect(row.code).toBe('RELIO-ABCDE');
    expect(row.referredEmail).toBe('bobi@test.cm');
    expect(row.rewardedAt).toBeNull();
  });

  it('accepte un code en minuscules (saisie depuis un lien)', async () => {
    const { service, referrals } = world({ users: { ...USERS } });
    await service.registerReferral('referred', 'relio-abcde');
    expect([...referrals.values()][0]!.code).toBe('RELIO-ABCDE');
  });

  it('code de SYNTAXE invalide (caractère hors alphabet) → refus, aucune ligne', async () => {
    const { service, referrals } = world({ users: { ...USERS } });
    // « 0 » est hors alphabet : un code mal recopié est signalé, pas deviné.
    await expect(service.registerReferral('referred', 'RELIO-AB0DE')).rejects.toThrow(
      /invalide/i,
    );
    expect(referrals.size).toBe(0);
  });

  it('code INCONNU (syntaxe valide, aucun porteur) → refus, aucune ligne', async () => {
    const { service, referrals } = world({ users: { ...USERS } });
    await expect(
      service.registerReferral('referred', 'RELIO-ZZZZZ'),
    ).rejects.toThrow(/inconnu/i);
    expect(referrals.size).toBe(0);
  });

  it('ANTI-ABUS : auto-parrainage refusé, aucune ligne', async () => {
    const { service, referrals } = world({ users: { ...USERS } });
    await expect(service.registerReferral('referrer', 'RELIO-ABCDE')).rejects.toThrow(
      /votre propre code/i,
    );
    expect(referrals.size).toBe(0);
  });

  it('un client déjà parrainé est refusé (l’unicité referredId prévient)', async () => {
    const { service, referrals } = world({ users: { ...USERS } });
    await service.registerReferral('referred', 'RELIO-ABCDE');
    expect(referrals.size).toBe(1);
    await expect(service.registerReferral('referred', 'RELIO-ABCDE')).rejects.toThrow(
      /déjà rattaché/i,
    );
    expect(referrals.size).toBe(1);
  });

  it('limite de 5 : le 6ᵉ filleul s’inscrit SANS récompense (EXPIRED)', async () => {
    const seeded = Array.from({ length: REFERRAL_MAX_REFERRALS }, (_, i) => ({
      id: `ref-${i}`,
      referrerId: 'referrer',
      referredId: `filleul-${i}`,
      code: `RELIO-CODE${i}`.slice(0, 11),
      status: 'REGISTERED',
      createdAt: new Date('2026-10-01T10:00:00Z'),
    }));
    const { service, referrals } = world({ users: { ...USERS }, referrals: seeded });
    const result = await service.registerReferral('referred', 'RELIO-ABCDE');
    expect(result.success).toBe(false);
    /* La ligne EST créée : sans elle, le compte pourrait être « offert » à un
     * autre parrain via un second code, ce qui contournerait la limite. */
    expect(referrals.size).toBe(REFERRAL_MAX_REFERRALS + 1);
    const last = [...referrals.values()].find((r) => r.referredId === 'referred')!;
    expect(last.status).toBe('EXPIRED');
  });

  it('les emplacements occupés ignorent PENDING et EXPIRED', async () => {
    const seeded = [
      {
        id: 'r1', referrerId: 'referrer', referredId: 'f1', code: 'RELIO-PEND01',
        status: 'PENDING', createdAt: new Date('2026-10-01T10:00:00Z'),
      },
      {
        id: 'r2', referrerId: 'referrer', referredId: 'f2', code: 'RELIO-EXPI01',
        status: 'EXPIRED', createdAt: new Date('2026-10-01T10:00:00Z'),
      },
    ];
    const { service, referrals } = world({ users: { ...USERS }, referrals: seeded });
    const result = await service.registerReferral('referred', 'RELIO-ABCDE');
    expect(result.success).toBe(true);
    expect([...referrals.values()].find((r) => r.referredId === 'referred')!.status).toBe(
      'REGISTERED',
    );
  });
});

/* ── onReferredMissionConfirmed ─────────────────────────────────────────── */

describe('onReferredMissionConfirmed : versement après la 1ʳᵉ mission confirmée', () => {
  function registered() {
    return world({
      users: { ...USERS },
      referrals: [
        {
          id: 'ref-1',
          referrerId: 'referrer',
          referredId: 'referred',
          code: 'RELIO-ABCDE',
          status: 'REGISTERED',
          createdAt: new Date('2026-10-01T10:00:00Z'),
        },
      ],
    });
  }

  it('crédite le parrain ET le filleul du montant du barème', async () => {
    const { service, ledger, notifications } = registered();
    const rewarded = await service.onReferredMissionConfirmed('referred');
    expect(rewarded).toBe(true);

    expect(ledger.size).toBe(2);
    const par = [...ledger.values()].find((t) => t.userId === 'referrer')!;
    const fil = [...ledger.values()].find((t) => t.userId === 'referred')!;

    expect(par.amount).toBe(REFERRAL_REWARD_XAF);
    expect(par.type).toBe('CLIENT_REFERRAL_REWARD');
    expect(par.direction).toBe('CREDIT');
    expect(fil.amount).toBe(REFERRAL_WELCOME_XAF);
    expect(fil.type).toBe('CLIENT_REFERRAL_RECEIVED');
    /* Aucune écriture n'est rattachée à une mission : la récompense vient
     * d'un geste commercial, pas d'une prestation. */
    expect(par.demandeId).toBeNull();
    expect(fil.demandeId).toBeNull();
    /* Le montant reste un ENTIER XAF : règle FCFA, pas de formatage en base. */
    expect(typeof par.amount).toBe('number');
    expect(Number.isInteger(par.amount)).toBe(true);

    expect(notifications.notifyReferrerRewarded).toHaveBeenCalledWith(
      'referrer',
      'Bobi K.',
    );
    expect(notifications.notifyReferredRewarded).toHaveBeenCalledWith('referred');
  });

  it('passe le parrainage à REWARDED et horodate le versement', async () => {
    const { service, referrals } = registered();
    await service.onReferredMissionConfirmed('referred');
    const row = [...referrals.values()][0]!;
    expect(row.status).toBe('REWARDED');
    expect(row.rewardedAt).toBeInstanceOf(Date);
  });

  it('IDEMPOTENCE : une seconde confirmation ne crédite RIEN', async () => {
    const { service, ledger, notifications } = registered();
    expect(await service.onReferredMissionConfirmed('referred')).toBe(true);
    const afterFirst = ledger.size;

    /* Le second appel voit `status = REWARDED` : rien à faire. */
    expect(await service.onReferredMissionConfirmed('referred')).toBe(false);
    expect(ledger.size).toBe(afterFirst);
    expect(notifications.notifyReferrerRewarded).toHaveBeenCalledTimes(1);
  });

  it('CONCURRENCE : le claim atomique protège contre deux versements', async () => {
    const { service, prisma, ledger } = registered();
    /* Deux confirmations quasi simultanées : la seconde voit `count: 0` sur
     * l'`updateMany` gardé et n'écrit rien. */
    const [a, b] = await Promise.all([
      service.onReferredMissionConfirmed('referred'),
      service.onReferredMissionConfirmed('referred'),
    ]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(ledger.size).toBe(2);
    expect(prisma.referral.updateMany).toHaveBeenCalled();
  });

  it('client SANS parrainage → rien, silencieusement', async () => {
    const { service, ledger, notifications } = world({ users: { ...USERS } });
    expect(await service.onReferredMissionConfirmed('referred')).toBe(false);
    expect(ledger.size).toBe(0);
    expect(notifications.notifyReferrerRewarded).not.toHaveBeenCalled();
  });

  it('parrainage déjà RÉCOMPENSÉ → rien à la mission suivante', async () => {
    const { service, ledger } = world({
      users: { ...USERS },
      referrals: [
        {
          id: 'ref-1', referrerId: 'referrer', referredId: 'referred',
          code: 'RELIO-ABCDE', status: 'REWARDED',
          rewardedAt: new Date('2026-10-02T10:00:00Z'),
          createdAt: new Date('2026-10-01T10:00:00Z'),
        },
      ],
    });
    expect(await service.onReferredMissionConfirmed('referred')).toBe(false);
    expect(ledger.size).toBe(0);
  });

  it('parrainage EXPIRED (limite atteinte) → jamais récompensé', async () => {
    const { service, ledger } = world({
      users: { ...USERS },
      referrals: [
        {
          id: 'ref-1', referrerId: 'referrer', referredId: 'referred',
          code: 'RELIO-ABCDE', status: 'EXPIRED',
          createdAt: new Date('2026-10-01T10:00:00Z'),
        },
      ],
    });
    expect(await service.onReferredMissionConfirmed('referred')).toBe(false);
    expect(ledger.size).toBe(0);
  });

  it('rafraîchit la page parrainage du parrain via SSE', async () => {
    const { service, realtime } = registered();
    await service.onReferredMissionConfirmed('referred');
    expect(realtime.publishToUser).toHaveBeenCalledWith(
      'referrer',
      'client.referrals_updated',
      expect.objectContaining({ status: 'REWARDED' }),
    );
  });
});

/* ── getMyReferrals ────────────────────────────────────────────────────── */

describe('getMyReferrals : vue de la page', () => {
  it('renvoie code, lien de partage, progression et liste', async () => {
    const { service } = world({
      users: { ...USERS },
      referrals: [
        {
          id: 'ref-1', referrerId: 'referrer', referredId: 'referred',
          code: 'RELIO-ABCDE', status: 'REWARDED',
          createdAt: new Date('2026-10-01T10:00:00Z'),
          rewardedAt: new Date('2026-10-05T10:00:00Z'),
        },
        {
          id: 'ref-2', referrerId: 'referrer', referredId: 'ami',
          code: 'RELIO-FFGGH', status: 'REGISTERED',
          createdAt: new Date('2026-10-03T10:00:00Z'),
        },
      ],
    });
    const view = await service.getMyReferrals('referrer');
    expect(view.code).toBe('RELIO-ABCDE');
    expect(view.shareUrl).toBe(
      'https://www.relioo.space/client/inscription?ref=RELIO-ABCDE',
    );
    expect(view.maxReferrals).toBe(REFERRAL_MAX_REFERRALS);
    expect(view.usedSlots).toBe(2);
    expect(view.rewardedCount).toBe(1);
    expect(view.referrals).toHaveLength(2);
    expect(view.referrals[0]!.referredName).toBe('Bobi K.');
    expect(view.referrals[1]!.referredName).toBeNull();
  });

  it('crée le code au besoin pour un client qui n’a jamais parrainé', async () => {
    const { service } = world({ users: { neuf: { firstName: 'Nouveau' } } });
    const view = await service.getMyReferrals('neuf');
    expect(isValidReferralCode(view.code)).toBe(true);
    expect(view.referrals).toEqual([]);
    expect(view.usedSlots).toBe(0);
    expect(view.rewardedCount).toBe(0);
  });

  it('ne montre QUE les parrainages du client connecté', async () => {
    const { service } = world({
      users: { ...USERS },
      referrals: [
        {
          id: 'ref-1', referrerId: 'AUTRE', referredId: 'x', code: 'RELIO-OTHER1',
          status: 'REWARDED', createdAt: new Date('2026-10-01T10:00:00Z'),
        },
        {
          id: 'ref-2', referrerId: 'referrer', referredId: 'referred',
          code: 'RELIO-ABCDE', status: 'REGISTERED',
          createdAt: new Date('2026-10-02T10:00:00Z'),
        },
      ],
    });
    const view = await service.getMyReferrals('referrer');
    expect(view.referrals).toHaveLength(1);
    expect(view.referrals[0]!.id).toBe('ref-2');
  });
});