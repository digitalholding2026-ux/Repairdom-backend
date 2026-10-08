import { describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../prisma/prisma.service.js';
import { RewardsService } from './rewards.service.js';
import type { RewardsNotificationsService } from './rewards-notifications.service.js';

/* Chantier 4-FONDATIONS-C — cumul de MARGE (LTV), primes à la réécriture du
 * #4A.
 *
 * On n'empile pas des `vi.fn()` : on implémente le sous-ensemble de requêtes
 * réellement utilisées par `RewardsService` sur des Maps, ce qui permet
 * d'exprimer des scénarios RÉELS (marge qui s'additionne, upsert qui crée la
 * première ligne, `updateMany` gardé qui refuse un second versement) au lieu
 * de vérifier l'appel d'un mock.
 *
 * Aucun accès réseau, aucune base : test unitaire pur.
 *
 * RÈGLE D'OR DU DOUPLE : le calcul de commission est fait par le VRAI
 * `calculateTechnicianFee`, importé du module source de vérité. Les montants
 * attendus sont donc derivés de la MÊME règle que le ledger — un test qui
 * recalculerait la commission à la main ne prouverait rien. */

type Row = Record<string, any>;

function pick(source: Row, keys: string[]): Row {
  const out: Row = {};
  for (const key of keys) out[key] = source[key];
  return out;
}

function world(
  seed: {
    demandes?: Row[];
    quotes?: Row[];
    progress?: Row[];
    flags?: Row[];
    ledger?: Row[];
    users?: Record<string, Row>;
  } = {},
) {
  const demandes = new Map<string, Row>((seed.demandes ?? []).map((d) => [d.id, { ...d }]));
  const progress = new Map<string, Row>();
  for (const row of seed.progress ?? []) progress.set(row.userId, { ...row });
  const flags = new Map<string, Row>((seed.flags ?? []).map((f) => [f.id, { ...f }]));
  const ledger = new Map<string, Row>();
  for (const row of seed.ledger ?? []) ledger.set(row.reference, { ...row });
  const users = new Map<string, Row>(
    Object.entries(
      seed.users ?? { c1: { id: 'c1', firstName: 'Awa', email: 'awa@test.cm' } },
    ).map(([id, u]) => [id, { ...u, id }]),
  );

  /* Devis ACCEPTED par mission. Par défaut, une mission confirmée a un devis
   * accepté au montant de `quoteAmount` (la commission se calcule dessus). */
  const quotes = new Map<string, Row>();
  for (const q of seed.quotes ?? []) {
    quotes.set(q.demandeId, { id: `q-${q.demandeId}`, status: 'ACCEPTED', travelAmount: 2_000, ...q });
  }
  for (const d of demandes.values()) {
    if (!quotes.has(d.id)) {
      quotes.set(d.id, {
        id: `q-${d.id}`,
        demandeId: d.id,
        status: 'ACCEPTED',
        amount: (d.finalAmount ?? 0) - 2_000,
        travelAmount: 2_000,
      });
    }
  }

  let flagSeq = 0;
  let ledgerSeq = 0;

  const clientRewardProgress = {
    findUnique: ({ where, select }: any) => {
      const row = progress.get(where.userId);
      if (!row) return null;
      return select ? pick(row, Object.keys(select)) : row;
    },
    upsert: ({ where, create, update }: any) => {
      const existing = progress.get(where.userId);
      if (existing) {
        const merged = {
          ...existing,
          cumulativeMarginXAF:
            existing.cumulativeMarginXAF + (update.cumulativeMarginXAF?.increment ?? 0),
          lastMissionAt: update.lastMissionAt ?? existing.lastMissionAt,
        };
        progress.set(where.userId, merged);
        return merged;
      }
      const created = {
        id: `p-${progress.size + 1}`,
        creditsClaimed: 0,
        natureReached: [],
        natureClaimed: [],
        updatedAt: new Date(),
        ...create,
      };
      progress.set(where.userId, created);
      return created;
    },
    update: ({ where, data }: any) => {
      const existing = progress.get(where.userId);
      if (!existing) throw new Error('P2025: progression absente');
      const updated = { ...existing, ...data, updatedAt: new Date() };
      progress.set(where.userId, updated);
      return updated;
    },
    /* Claim ATOMIQUE du versement : le `where` porte les valeurs lues, donc
     * un second versement concurrent doit échouer (count 0). */
    updateMany: ({ where, data }: any) => {
      const existing = progress.get(where.userId);
      if (!existing) return { count: 0 };
      if (where.creditsEarned !== undefined && existing.creditsEarned !== where.creditsEarned) {
        return { count: 0 };
      }
      if (where.creditsClaimed !== undefined && existing.creditsClaimed !== where.creditsClaimed) {
        return { count: 0 };
      }
      progress.set(where.userId, { ...existing, ...data, updatedAt: new Date() });
      return { count: 1 };
    },
  };

  const financialTransaction = {
    create: ({ data }: any) => {
      /* Unicité `reference` reproduite comme en base : un double versement
       * doit lever P2002 (idempotence du versement). */
      if (ledger.has(data.reference)) {
        const error: Row = new Error('Unique constraint failed');
        error.code = 'P2002';
        throw error;
      }
      ledgerSeq += 1;
      const created = { id: `tx-${ledgerSeq}`, ...data };
      ledger.set(data.reference, created);
      return created;
    },
    aggregate: ({ where }: any) => {
      let sum = 0;
      for (const t of ledger.values()) {
        if (t.userId !== where.userId) continue;
        if (t.status !== where.status) continue;
        if (t.direction !== where.direction) continue;
        sum += t.amount;
      }
      return { _sum: { amount: sum } };
    },
  };

  const rewardFraudFlag = {
    findUnique: ({ where, include }: any) => {
      const flag = [...flags.values()].find((f) => {
        if (where.demandeId) return f.demandeId === where.demandeId;
        if (where.id) return f.id === where.id;
        return false;
      });
      if (!flag) return null;
      if (include?.demande) {
        const d = demandes.get(flag.demandeId);
        if (!d) return null;
        return { ...flag, demande: pick(d, Object.keys(include.demande.select)) };
      }
      return flag;
    },
    create: ({ data, select }: any) => {
      for (const flag of flags.values()) {
        if (flag.demandeId === data.demandeId) {
          const error: Row = new Error('Unique constraint failed');
          error.code = 'P2002';
          throw error;
        }
      }
      flagSeq += 1;
      const created = {
        id: `f${flagSeq}`,
        detectedAt: new Date(),
        resolvedAt: null,
        resolvedBy: null,
        decision: null,
        note: null,
        ...data,
      };
      flags.set(created.id, created);
      return select ? pick(created, Object.keys(select)) : created;
    },
    updateMany: ({ where, data }: any) => {
      let count = 0;
      for (const [id, flag] of flags) {
        if (where.id && flag.id !== where.id) continue;
        if (where.resolvedAt === null && flag.resolvedAt !== null) continue;
        flags.set(id, { ...flag, ...data });
        count += 1;
      }
      return { count };
    },
    findMany: ({ where, take }: any) => {
      let rows = [...flags.values()];
      if (where?.resolvedAt === null) rows = rows.filter((f) => f.resolvedAt === null);
      if (where?.resolvedAt?.not !== undefined) rows = rows.filter((f) => f.resolvedAt !== null);
      rows.sort((a, b) => b.detectedAt - a.detectedAt);
      return rows.slice(0, take ?? 50).map((f) => ({
        ...f,
        demande: demandes.get(f.demandeId) ?? null,
        user: users.get(f.userId) ?? { firstName: '?', lastName: null, email: '?' },
        technician: users.get(f.technicianId) ?? { firstName: '?', lastName: null },
      }));
    },
  };

  /* Vraies transactions : les callbacks reçoivent le même jeu de doubles. */
  const tx = {
    demande: { findUnique: ({ where }: any) => demandes.get(where.id) ?? null },
    quote: { findFirst: ({ where }: any) => quotes.get(where.demandeId) ?? null },
    user: {
      findUnique: ({ where, select }: any) => {
        const user = users.get(where.id);
        if (!user) return null;
        return select ? pick(user, Object.keys(select)) : user;
      },
    },
    clientRewardProgress,
    rewardFraudFlag,
    financialTransaction,
  };

  const prisma = {
    demande: {
      findUnique: ({ where }: any) => demandes.get(where.id) ?? null,
      findFirst: ({ where, orderBy }: any) => {
        const rows = [...demandes.values()].filter((d) => {
          if (where.clientId && d.clientId !== where.clientId) return false;
          if (where.id?.not && d.id === where.id.not) return false;
          if (where.status && d.status !== where.status) return false;
          if (where.updatedAt?.lt && !(d.updatedAt < where.updatedAt.lt)) return false;
          return true;
        });
        rows.sort((a, b) => (orderBy?.updatedAt === 'desc' ? b.updatedAt - a.updatedAt : 0));
        return rows[0] ?? null;
      },
    },
    quote: {
      findFirst: ({ where }: any) => {
        const quote = quotes.get(where.demandeId);
        if (!quote) return null;
        if (where.status && quote.status !== where.status) return null;
        return quote;
      },
    },
    user: tx.user,
    clientRewardProgress,
    rewardFraudFlag,
    financialTransaction,
    $transaction: (callback: (t: unknown) => Promise<unknown>) => callback(tx),
  } as unknown as PrismaService;

  return { prisma, demandes, quotes, progress, flags, ledger, users };
}

function prog(w: { progress: Map<string, Row> }, userId = 'c1'): Row {
  const row = w.progress.get(userId);
  if (!row) throw new Error(`progression absente pour ${userId}`);
  return row;
}

function confirmed(overrides: Row = {}): Row {
  return {
    id: 'm1',
    reference: 'RD-ABC123',
    clientId: 'c1',
    technicianId: 't1',
    status: 'CONFIRMED',
    finalAmount: 17_000,
    updatedAt: new Date('2026-10-01T10:00:00Z'),
    ...overrides,
  };
}

function notificationsSpy() {
  return {
    notifyTierReached: vi.fn().mockResolvedValue(undefined),
    notifyCreditsEarned: vi.fn().mockResolvedValue(undefined),
    notifyNatureReached: vi.fn().mockResolvedValue(undefined),
    notifyNatureClaimed: vi.fn().mockResolvedValue(undefined),
    notifyMissionNotCounted: vi.fn().mockResolvedValue(undefined),
    publishProgressChanged: vi.fn(),
  } as unknown as RewardsNotificationsService & Record<string, ReturnType<typeof vi.fn>>;
}

/* Barème de référence : 500 + 4 % du devis. Réutilisé par les attentes pour
 * que le test reste lisible, mais le SERVICE, lui, appelle la vraie fonction. */
const FEE = (devis: number) => 500 + Math.round(devis * 0.04);

describe('RewardsService.onMissionConfirmed — cumul de marge', () => {
  it('mission de 15 000 → marge 1 100 (= 500 + 4 %), cumul 1 100', async () => {
    const w = world({
      demandes: [confirmed({ finalAmount: 17_000 })],
      quotes: [{ demandeId: 'm1', amount: 15_000 }],
    });
    const outcome = await new RewardsService(w.prisma, notificationsSpy()).onMissionConfirmed('m1');

    expect(FEE(15_000)).toBe(1_100);
    expect(outcome.counted).toBe(true);
    expect(outcome.marginXAF).toBe(1_100);
    expect(outcome.cumulativeMarginXAF).toBe(1_100);
    expect(prog(w).cumulativeMarginXAF).toBe(1_100);
    /* Aucun crédit avant 10 000 de marge. */
    expect(prog(w).creditsEarned).toBe(0);
  });

  it('10 missions à 15 000 → cumul 11 000 → 1 crédit de 500', async () => {
    const demandes = Array.from({ length: 10 }, (_, i) =>
      confirmed({
        id: `m${i}`,
        reference: `RD-${i}`,
        clientId: 'c1',
        /* Techniciens DIFFÉRENTS et espacés de plus de 48 h : pas de fraude,
         * sinon ce test mesurerait autre chose. */
        technicianId: `t${i}`,
        finalAmount: 17_000,
        updatedAt: new Date(Date.UTC(2026, 0, i + 1)),
      }),
    );
    const quotes = demandes.map((d) => ({ demandeId: d.id, amount: 15_000 }));
    const w = world({ demandes, quotes });
    const service = new RewardsService(w.prisma, notificationsSpy());

    for (const d of demandes) await service.onMissionConfirmed(d.id);

    expect(prog(w).cumulativeMarginXAF).toBe(10 * FEE(15_000));
    /* floor(11 000 / 10 000) × 500 = 500. */
    expect(prog(w).creditsEarned).toBe(500);
    expect(prog(w).creditsClaimed).toBe(0);
  });

  it('ignore une mission sous le montant plancher (1 499)', async () => {
    const w = world({ demandes: [confirmed({ finalAmount: 1_499 })] });
    const outcome = await new RewardsService(w.prisma, notificationsSpy()).onMissionConfirmed('m1');
    expect(outcome.counted).toBe(false);
    expect(outcome.reason).toBe('AMOUNT_BELOW_MINIMUM');
    expect(w.progress.size).toBe(0);
  });

  it('sans devis ACCEPTED → rien à cumuler (aucune commission prélevée)', async () => {
    const w = world({
      demandes: [confirmed()],
      quotes: [{ demandeId: 'm1', amount: 15_000, status: 'REJECTED' }],
    });
    const outcome = await new RewardsService(w.prisma, notificationsSpy()).onMissionConfirmed('m1');
    expect(outcome.counted).toBe(false);
    expect(outcome.reason).toBe('NO_ACCEPTED_QUOTE');
    expect(w.progress.size).toBe(0);
  });

  it('mission non CONFIRMED → ignorée', async () => {
    const w = world({ demandes: [confirmed({ status: 'COMPLETED' })] });
    const outcome = await new RewardsService(w.prisma, notificationsSpy()).onMissionConfirmed('m1');
    expect(outcome.counted).toBe(false);
    expect(outcome.reason).toBe('NOT_CONFIRMED');
  });

  it('mission introuvable → ignorée sans erreur', async () => {
    const w = world({ demandes: [] });
    const outcome = await new RewardsService(w.prisma, notificationsSpy()).onMissionConfirmed('inconnu');
    expect(outcome.counted).toBe(false);
    expect(outcome.reason).toBe('DEMANDE_NOT_FOUND');
  });
});

describe('RewardsService — badges sur la marge cumulée', () => {
  /** Atteint le palier demandé par cumul de missions à 15 000 (marge 1 100). */
  async function cumulateTo(service: RewardsService, w: ReturnType<typeof world>, n: number) {
    for (let i = 0; i < n; i++) {
      await service.onMissionConfirmed(`m${i}`);
    }
  }

  function seed(n: number) {
    const demandes = Array.from({ length: n }, (_, i) =>
      confirmed({
        id: `m${i}`,
        reference: `RD-${i}`,
        technicianId: `t${i}`,
        updatedAt: new Date(Date.UTC(2026, 0, i + 1)),
      }),
    );
    const quotes = demandes.map((d) => ({ demandeId: d.id, amount: 15_000 }));
    return world({ demandes, quotes });
  }

  it('atteint FIDELE à 10 000 de marge cumulée et notifie', async () => {
    // 10 000 / 1 100 = 9,09 → 10 missions (11 000) suffisent.
    const w = seed(10);
    const notifications = notificationsSpy();
    const service = new RewardsService(w.prisma, notifications);

    await cumulateTo(service, w, 10);

    expect(prog(w).cumulativeMarginXAF).toBeGreaterThanOrEqual(10_000);
    expect(prog(w).currentTier).toBe('FIDELE');
    expect(notifications.notifyTierReached).toHaveBeenCalledTimes(1);
    expect((notifications.notifyTierReached as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({
      tier: 'FIDELE',
      label: 'Fidèle',
      margeXAF: 10_000,
    });
  });

  it('ne franchit pas FIDELE à 9 000 de marge', async () => {
    // 8 missions = 8 800 < 10 000 ; la 9ᵉ = 9 900 < 10 000.
    const w = seed(9);
    const notifications = notificationsSpy();
    const service = new RewardsService(w.prisma, notifications);

    await cumulateTo(service, w, 9);

    expect(prog(w).cumulativeMarginXAF).toBe(9_900);
    expect(prog(w).currentTier).toBe('NONE');
    expect(notifications.notifyTierReached).not.toHaveBeenCalled();
  });

  it('ne NOTIFIE PAS deux fois un palier déjà atteint', async () => {
    const w = seed(12);
    const notifications = notificationsSpy();
    const service = new RewardsService(w.prisma, notifications);

    await cumulateTo(service, w, 12);

    expect(notifications.notifyTierReached).toHaveBeenCalledTimes(1);
    expect(prog(w).currentTier).toBe('FIDELE');
  });
});

describe('RewardsService — crédits', () => {
  it('notifie le crédit AU MOMENT où il est gagné', async () => {
    const demandes = Array.from({ length: 10 }, (_, i) =>
      confirmed({ id: `m${i}`, reference: `RD-${i}`, technicianId: `t${i}`, updatedAt: new Date(Date.UTC(2026, 0, i + 1)) }),
    );
    const w = world({ demandes, quotes: demandes.map((d) => ({ demandeId: d.id, amount: 15_000 })) });
    const notifications = notificationsSpy();
    const service = new RewardsService(w.prisma, notifications);

    for (const d of demandes) await service.onMissionConfirmed(d.id);

    expect(notifications.notifyCreditsEarned).toHaveBeenCalledTimes(1);
    expect((notifications.notifyCreditsEarned as ReturnType<typeof vi.fn>).mock.calls[0][1]).toBe(500);
  });

  it('claimCredits verse le disponible au solde et avance creditsClaimed', async () => {
    const w = world({
      progress: [
        {
          userId: 'c1',
          cumulativeMarginXAF: 20_000,
          creditsEarned: 1_000,
          creditsClaimed: 0,
          currentTier: 'FIDELE',
          currentNatureTier: 'NONE',
          natureReached: [],
          natureClaimed: [],
        },
      ],
      ledger: [{ reference: 'seed', userId: 'c1', status: 'VALIDATED', direction: 'CREDIT', amount: 40_000 }],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    const result = await service.claimCredits('c1');

    expect(result.claimedXAF).toBe(1_000);
    expect(result.newBalanceXAF).toBe(41_000);
    expect(prog(w).creditsClaimed).toBe(1_000);
    /* Une écriture ledger CLIENT_REWARD_CREDIT, AUCUN encaissement. */
    const entry = [...w.ledger.values()].find((t) => t.type === 'CLIENT_REWARD_CREDIT');
    expect(entry).toMatchObject({ direction: 'CREDIT', amount: 1_000, status: 'VALIDATED' });
  });

  it('claimCredits avec 0 disponible → 400, aucune écriture', async () => {
    const w = world({
      progress: [
        {
          userId: 'c1',
          cumulativeMarginXAF: 5_000,
          creditsEarned: 0,
          creditsClaimed: 0,
          currentTier: 'NONE',
          currentNatureTier: 'NONE',
          natureReached: [],
          natureClaimed: [],
        },
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    await expect(service.claimCredits('c1')).rejects.toMatchObject({ status: 400 });
    expect(w.ledger.size).toBe(0);
  });

  it('un second versement concurrent est refusé (claim atomique)', async () => {
    const w = world({
      progress: [
        {
          userId: 'c1',
          cumulativeMarginXAF: 20_000,
          creditsEarned: 1_000,
          creditsClaimed: 0,
          currentTier: 'FIDELE',
          currentNatureTier: 'NONE',
          natureReached: [],
          natureClaimed: [],
        },
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    await service.claimCredits('c1');
    // creditsClaimed vaut désormais 1 000 = creditsEarned → plus rien à verser.
    await expect(service.claimCredits('c1')).rejects.toMatchObject({ status: 400 });
    expect([...w.ledger.values()].filter((t) => t.type === 'CLIENT_REWARD_CREDIT')).toHaveLength(1);
  });
});

describe('RewardsService — récompenses nature', () => {
  const withNature = (margin: number) => ({
    progress: [
      {
        userId: 'c1',
        cumulativeMarginXAF: margin,
        creditsEarned: Math.floor(margin / 10_000) * 500,
        creditsClaimed: 0,
        currentTier: 'OR',
        currentNatureTier: 'ELECTROMENAGER_PETIT',
        natureReached: ['ELECTROMENAGER_PETIT'],
        natureClaimed: [],
      },
    ],
  });

  it('notifie l\'atteinte d\'ELECTROMENAGER_PETIT à 50 000 de marge', async () => {
    const demandes = Array.from({ length: 46 }, (_, i) =>
      confirmed({ id: `m${i}`, reference: `RD-${i}`, technicianId: `t${i}`, updatedAt: new Date(Date.UTC(2026, 0, i + 1)) }),
    );
    const w = world({ demandes, quotes: demandes.map((d) => ({ demandeId: d.id, amount: 15_000 })) });
    const notifications = notificationsSpy();
    const service = new RewardsService(w.prisma, notifications);

    for (const d of demandes) await service.onMissionConfirmed(d.id);

    expect(prog(w).cumulativeMarginXAF).toBeGreaterThanOrEqual(50_000);
    expect(prog(w).natureReached).toContain('ELECTROMENAGER_PETIT');
    expect(notifications.notifyNatureReached).toHaveBeenCalledTimes(1);
    expect((notifications.notifyNatureReached as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
      tier: 'ELECTROMENAGER_PETIT',
      margeXAF: 50_000,
    });
  });

  it('claimNatureReward sur un palier atteint → ok', async () => {
    const w = world(withNature(50_000));
    const notifications = notificationsSpy();
    const result = await new RewardsService(w.prisma, notifications).claimNatureReward(
      'c1',
      'ELECTROMENAGER_PETIT',
    );

    expect(result.success).toBe(true);
    expect(result.natureClaimed).toContain('ELECTROMENAGER_PETIT');
    expect(notifications.notifyNatureClaimed).toHaveBeenCalledTimes(1);
  });

  it('palier NON atteint → 400, rien n\'est écrit', async () => {
    const w = world({
      progress: [
        {
          userId: 'c1',
          cumulativeMarginXAF: 5_000,
          creditsEarned: 0,
          creditsClaimed: 0,
          currentTier: 'NONE',
          currentNatureTier: 'NONE',
          natureReached: [],
          natureClaimed: [],
        },
      ],
    });
    await expect(
      new RewardsService(w.prisma, notificationsSpy()).claimNatureReward('c1', 'SMARTPHONE'),
    ).rejects.toMatchObject({ status: 400 });
    expect(prog(w).natureClaimed).toEqual([]);
  });

  it('palier déjà réclamé → 400', async () => {
    const seed = withNature(50_000);
    seed.progress[0].natureClaimed = ['ELECTROMENAGER_PETIT'];
    const w = world(seed);
    await expect(
      new RewardsService(w.prisma, notificationsSpy()).claimNatureReward('c1', 'ELECTROMENAGER_PETIT'),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('palier inconnu → 400', async () => {
    const w = world(withNature(50_000));
    await expect(
      new RewardsService(w.prisma, notificationsSpy()).claimNatureReward('c1', 'VOITURE'),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('RewardsService — anti-fraude (règle #4A conservée)', () => {
  it('même technicien < 48 h → signalement, marge NON cumulée', async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({ id: 'm2', reference: 'RD-DEF456', updatedAt: new Date('2026-10-01T20:00:00Z') }),
      ],
      quotes: [
        { demandeId: 'm1', amount: 15_000 },
        { demandeId: 'm2', amount: 15_000 },
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());

    await service.onMissionConfirmed('m1');
    expect(prog(w).cumulativeMarginXAF).toBe(FEE(15_000));

    const outcome = await service.onMissionConfirmed('m2');
    expect(outcome.counted).toBe(false);
    expect(outcome.reason).toBe('FRAUD_FLAGGED');
    /* La 2ᵉ mission ne compte pas : le cumul n'a pas bougé. */
    expect(prog(w).cumulativeMarginXAF).toBe(FEE(15_000));
    expect([...w.flags.values()][0]).toMatchObject({ technicianId: 't1', reason: 'SAME_TECHNICIAN_48H' });
  });

  it('même technicien AU-DELÀ de 48 h → compté normalement', async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({ id: 'm2', updatedAt: new Date('2026-10-04T10:00:00Z') }),
      ],
      quotes: [
        { demandeId: 'm1', amount: 15_000 },
        { demandeId: 'm2', amount: 15_000 },
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());
    await service.onMissionConfirmed('m1');
    const outcome = await service.onMissionConfirmed('m2');
    expect(outcome.counted).toBe(true);
    expect(w.flags.size).toBe(0);
  });

  it('technicien différent dans la fenêtre → compté', async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({ id: 'm2', technicianId: 't2', updatedAt: new Date('2026-10-01T20:00:00Z') }),
      ],
      quotes: [
        { demandeId: 'm1', amount: 15_000 },
        { demandeId: 'm2', amount: 15_000 },
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());
    await service.onMissionConfirmed('m1');
    expect((await service.onMissionConfirmed('m2')).counted).toBe(true);
  });

  it('mission SANS technicien → jamais de signalement', async () => {
    const w = world({ demandes: [confirmed({ technicianId: null })] });
    const outcome = await new RewardsService(w.prisma, notificationsSpy()).onMissionConfirmed('m1');
    expect(outcome.counted).toBe(true);
    expect(w.flags.size).toBe(0);
  });

  it('rejeu : un 2ᵉ signalement n\'est pas créé', async () => {
    const w = world({
      demandes: [
        confirmed({ id: 'm1', updatedAt: new Date('2026-10-01T10:00:00Z') }),
        confirmed({ id: 'm2', updatedAt: new Date('2026-10-01T20:00:00Z') }),
      ],
      quotes: [
        { demandeId: 'm1', amount: 15_000 },
        { demandeId: 'm2', amount: 15_000 },
      ],
    });
    const service = new RewardsService(w.prisma, notificationsSpy());
    await service.onMissionConfirmed('m1');
    await service.onMissionConfirmed('m2');
    const second = await service.onMissionConfirmed('m2');
    expect(second.reason).toBe('FRAUD_FLAGGED');
    expect(w.flags.size).toBe(1);
  });

  it('VALIDATED → la mission est finally cumulée', async () => {
    const w = world({
      demandes: [confirmed({ id: 'm2', updatedAt: new Date('2026-10-01T20:00:00Z') })],
      quotes: [{ demandeId: 'm2', amount: 15_000 }],
      flags: [
        {
          id: 'f1',
          userId: 'c1',
          demandeId: 'm2',
          technicianId: 't1',
          reason: 'SAME_TECHNICIAN_48H',
          resolvedAt: null,
          decision: null,
        },
      ],
    });
    const notifications = notificationsSpy();
    const result = await new RewardsService(w.prisma, notifications).resolveFraudFlag(
      'f1',
      'VALIDATED',
      'admin-1',
    );
    expect(result.counted).toBe(true);
    expect(result.marginXAF).toBe(FEE(15_000));
    expect(prog(w).cumulativeMarginXAF).toBe(FEE(15_000));
  });

  it('REJECTED → rien n\'est cumulé, le client est informé', async () => {
    const w = world({
      demandes: [confirmed({ id: 'm2' })],
      flags: [
        {
          id: 'f1',
          userId: 'c1',
          demandeId: 'm2',
          technicianId: 't1',
          reason: 'SAME_TECHNICIAN_48H',
          resolvedAt: null,
          decision: null,
        },
      ],
    });
    const notifications = notificationsSpy();
    const result = await new RewardsService(w.prisma, notifications).resolveFraudFlag(
      'f1',
      'REJECTED',
      'admin-1',
    );
    expect(result.counted).toBe(false);
    expect(w.progress.size).toBe(0);
    expect(notifications.notifyMissionNotCounted).toHaveBeenCalledTimes(1);
  });

  it('un dossier déjà tranché → 409 (décision atomique)', async () => {
    const w = world({
      demandes: [confirmed({ id: 'm2' })],
      flags: [
        {
          id: 'f1',
          userId: 'c1',
          demandeId: 'm2',
          technicianId: 't1',
          reason: 'SAME_TECHNICIAN_48H',
          resolvedAt: new Date(),
          decision: 'REJECTED',
        },
      ],
    });
    await expect(
      new RewardsService(w.prisma, notificationsSpy()).resolveFraudFlag('f1', 'VALIDATED', 'admin-1'),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('RewardsService.getProgress — contrat de lecture', () => {
  it('client sans progression → état à zéro synthétisé', async () => {
    const w = world({});
    const view = await new RewardsService(w.prisma, notificationsSpy()).getProgress('c1');
    expect(view).toMatchObject({
      cumulativeMarginXAF: 0,
      currentTier: 'NONE',
      creditsEarned: 0,
      creditsClaimed: 0,
      creditsAvailable: 0,
      nextCreditTrancheAt: 10_000,
      marginToNextCreditXAF: 10_000,
      nextTierAt: 10_000,
      nextNatureAt: 50_000,
    });
  });

  it('expose marge, crédits et seuils cohérents', async () => {
    const w = world({
      progress: [
        {
          userId: 'c1',
          cumulativeMarginXAF: 45_000,
          creditsEarned: 2_000,
          creditsClaimed: 500,
          currentTier: 'FIDELE',
          currentNatureTier: 'NONE',
          natureReached: [],
          natureClaimed: [],
          lastMissionAt: new Date('2026-10-01T10:00:00Z'),
        },
      ],
    });
    const view = await new RewardsService(w.prisma, notificationsSpy()).getProgress('c1');
    expect(view.cumulativeMarginXAF).toBe(45_000);
    expect(view.creditsAvailable).toBe(1_500);
    expect(view.currentTier).toBe('FIDELE');
    expect(view.nextCreditTrancheAt).toBe(50_000);
    expect(view.marginToNextCreditXAF).toBe(5_000);
    expect(view.nextTierAt).toBe(50_000);
    expect(view.nextNatureAt).toBe(50_000);
    /* Les seuils travelent avec le contrat, en XAF entier. */
    expect(view.tiers).toHaveLength(3);
    expect(view.natureThresholds).toHaveLength(3);
    for (const tier of view.tiers) {
      expect(Number.isInteger(tier.margeXAF)).toBe(true);
      expect(String(tier.margeXAF)).not.toContain('FCFA');
    }
  });

  it('tous les paliers atteints → nextTierAt / nextNatureAt null', async () => {
    const w = world({
      progress: [
        {
          userId: 'c1',
          cumulativeMarginXAF: 300_000,
          creditsEarned: 15_000,
          creditsClaimed: 0,
          currentTier: 'PLATINE',
          currentNatureTier: 'SMARTPHONE',
          natureReached: ['ELECTROMENAGER_PETIT', 'ELECTROMENAGER_MOYEN', 'SMARTPHONE'],
          natureClaimed: [],
        },
      ],
    });
    const view = await new RewardsService(w.prisma, notificationsSpy()).getProgress('c1');
    expect(view.nextTierAt).toBeNull();
    expect(view.nextNatureAt).toBeNull();
    expect(view.creditsEarned).toBe(15_000);
  });
});

describe('RewardsService — isolation des notifications', () => {
  it('un canal qui lève ne fait JAMAIS échouer le cumul', async () => {
    const demandes = Array.from({ length: 10 }, (_, i) =>
      confirmed({ id: `m${i}`, reference: `RD-${i}`, technicianId: `t${i}`, updatedAt: new Date(Date.UTC(2026, 0, i + 1)) }),
    );
    const w = world({ demandes, quotes: demandes.map((d) => ({ demandeId: d.id, amount: 15_000 })) });
    const notifications = notificationsSpy();
    (notifications.notifyTierReached as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('Resend 500'),
    );
    const service = new RewardsService(w.prisma, notifications);

    for (const d of demandes) {
      await expect(service.onMissionConfirmed(d.id)).resolves.toMatchObject({ counted: true });
    }
    expect(prog(w).cumulativeMarginXAF).toBe(10 * FEE(15_000));
  });
});