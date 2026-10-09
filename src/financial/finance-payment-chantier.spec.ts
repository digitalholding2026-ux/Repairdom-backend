import { describe, expect, it, vi } from 'vitest';
import { FinancialService } from './financial.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ConfigService } from '@nestjs/config';
import { normalizeMsisdn } from '../saspay/saspay-networks.js';

/* CHANTIER PAIEMENT P0/P1 — couverture backend des corrections, sans
 * opération réelle (Prisma simulé en mémoire). Les helpers purs frontend
 * (miroirs) sont couverts par `node --test src/lib/payment-helpers.test.ts`
 * côté frontend (Node 24, sans dépendance). */

type Row = Record<string, any>;

function mockPrisma(
  users: Record<string, { id: string; role: string }> = {
    c1: { id: 'c1', role: 'CLIENT' },
  },
  mode = 'SIMULATION',
) {
  const ledger: Row[] = [];
  const topups = new Map<string, Row>();
  const topupsByKey = new Map<string, Row>();
  const withdrawals = new Map<string, Row>();
  const withdrawalsByKey = new Map<string, Row>();
  const holds = new Map<string, Row>();
  let seq = 0;
  const nextId = (p: string) => `${p}-${(seq += 1)}`;

  const matchLedger = (t: Row, where: Row) =>
    (where.userId === undefined || t.userId === where.userId) &&
    (where.mode === undefined || t.mode === where.mode) &&
    (where.status === undefined || t.status === where.status) &&
    (where.direction === undefined || t.direction === where.direction) &&
    (where.type === undefined || t.type === where.type);

  const tx = {
    $executeRaw: vi.fn(async () => []),
    user: {
      findUnique: vi.fn(async ({ where }: any) => users[where.id] ?? null),
    },
    financialTransaction: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.reference) return ledger.find((t) => t.reference === where.reference) ?? null;
        if (where.id) return ledger.find((t) => t.id === where.id) ?? null;
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any = {}) => ledger.find((t) => matchLedger(t, where)) ?? null),
      create: vi.fn(async ({ data }: any) => {
        if (ledger.some((t) => t.reference === data.reference)) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        const row = { id: nextId('ft'), createdAt: new Date(), status: 'VALIDATED', mode, ...data };
        ledger.push(row);
        return row;
      }),
      aggregate: vi.fn(async ({ where }: any = {}) => ({
        _sum: { amount: ledger.filter((t) => matchLedger(t, where)).reduce((a, t) => a + t.amount, 0) },
      })),
    },
    topupIntent: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.reference) return topups.get(where.reference) ?? null;
        if (where.idempotencyKey) return topupsByKey.get(where.idempotencyKey) ?? null;
        if (where.id) return [...topups.values()].find((t) => t.id === where.id) ?? null;
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any = {}) => {
        return (
          [...topups.values()].find(
            (t) =>
              (where.saspayTransactionId === undefined || t.saspayTransactionId === where.saspayTransactionId) &&
              (where.status === undefined || t.status === where.status) &&
              (where.id?.not === undefined || t.id !== where.id.not),
          ) ?? null
        );
      }),
      create: vi.fn(async ({ data }: any) => {
        if (topups.has(data.reference) || topupsByKey.has(data.idempotencyKey)) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        const row = {
          id: nextId('ti'), createdAt: new Date(), updatedAt: new Date(),
          currency: 'XAF', mode, status: 'PENDING',
          saspayTransactionId: null, saspayReference: null, externalReference: null,
          network: null, country: null, requestedAmount: null, fee: null,
          chargedAmount: null, netAmount: null, creditedTransactionId: null,
          errorMessage: null, ...data,
        };
        topups.set(row.reference, row);
        topupsByKey.set(row.idempotencyKey, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = [...topups.values()].find((t) => t.id === where.id || t.reference === where.reference);
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
    withdrawalRequest: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.reference) return withdrawals.get(where.reference) ?? null;
        if (where.idempotencyKey) return withdrawalsByKey.get(where.idempotencyKey) ?? null;
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        if (withdrawals.has(data.reference) || withdrawalsByKey.has(data.idempotencyKey)) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        const row = {
          id: nextId('wr'), createdAt: new Date(), updatedAt: new Date(),
          currency: 'XAF', mode, status: 'PENDING', holdId: null, ledgerReference: null,
          saspayTransactionId: null, saspayReference: null, externalReference: null,
          network: null, country: null, requestedAmount: null, fee: null,
          chargedAmount: null, netAmount: null, errorMessage: null, ...data,
        };
        withdrawals.set(row.reference, row);
        withdrawalsByKey.set(row.idempotencyKey, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = [...withdrawals.values()].find((t) => t.id === where.id || t.reference === where.reference);
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return row;
      }),
    },
    fundsHold: {
      findUnique: vi.fn(async ({ where }: any) => holds.get(where.reference) ?? null),
      create: vi.fn(async ({ data }: any) => {
        if (holds.has(data.reference)) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        const row = { id: nextId('hold'), createdAt: new Date(), currency: 'XAF', mode, status: 'ACTIVE', releasedAt: null, ...data };
        holds.set(row.reference, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = holds.get(where.reference);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of holds.values()) {
          if ((where.id === undefined || row.id === where.id) && (where.status === undefined || row.status === where.status)) {
            Object.assign(row, data);
            count += 1;
          }
        }
        return { count };
      }),
      aggregate: vi.fn(async ({ where }: any = {}) => ({
        _sum: {
          amount: [...holds.values()]
            .filter(
              (h) =>
                (where.userId === undefined || h.userId === where.userId) &&
                (where.mode === undefined || h.mode === where.mode) &&
                (where.status === undefined || h.status === where.status),
            )
            .reduce((a, h) => a + h.amount, 0),
        },
      })),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  return { prisma, store: { ledger, topups, withdrawals, holds } };
}

function service(prisma: unknown, financialMode = 'SIMULATION') {
  const config = { get: vi.fn((key: string) => (key === 'FINANCIAL_MODE' ? financialMode : undefined)) } as unknown as ConfigService;
  return new FinancialService(prisma as PrismaService, config);
}

function credit(store: { ledger: Row[] }, userId: string, amount: number) {
  store.ledger.push({
    id: `seed-${store.ledger.length}`, createdAt: new Date(), status: 'VALIDATED',
    mode: 'SIMULATION', userId, type: 'CLIENT_TOPUP', direction: 'CREDIT',
    amount, reference: `seed-${store.ledger.length}`,
  });
}

describe('téléphone : normalisation E.164 convergente', () => {
  it('backend converge vers +237… (jamais de double préfixe)', () => {
    for (const raw of ['690000000', '237690000000', '+237690000000', '+237 690 00 00 00']) {
      expect(normalizeMsisdn(raw)).toBe('+237690000000');
    }
    expect(normalizeMsisdn('abc')).toBeNull();
    expect(normalizeMsisdn('12')).toBeNull();
  });

  it('numéro local stocké normalisé dans metadata (recharge + retrait)', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    const intent = await svc.createTopupIntent('c1', 'c1', 5000, {
      idempotencyKey: 'tel-1', network: 'mtn_cm', phone: '690000000',
    });
    expect((store.topups.get(intent.reference)?.metadata as Row)?.phone).toBe('+237690000000');

    credit(store, 'c1', 20000);
    const req = await svc.createWithdrawalRequest('c1', 'c1', 5000, {
      idempotencyKey: 'tel-2', network: 'mtn_cm', msisdn: '677889900',
    });
    expect((store.withdrawals.get(req.reference)?.metadata as Row)?.msisdn).toBe('+237677889900');
  });
});

describe('montants : bornes 100 / 10 000 000 (backend + pré-validation)', () => {
  it.each([50, 99])('recharge %i → 400', async (amount) => {
    const { prisma } = mockPrisma();
    await expect(
      service(prisma).createTopupIntent('c1', 'c1', amount, { idempotencyKey: `b-t-${amount}` }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each([100, 10_000_000])('recharge %i → PENDING', async (amount) => {
    const { prisma } = mockPrisma();
    const intent = await service(prisma).createTopupIntent('c1', 'c1', amount, {
      idempotencyKey: `ok-t-${amount}`,
    });
    expect(intent.status).toBe('PENDING');
  });

  it('recharge 10 000 001 → 400', async () => {
    const { prisma } = mockPrisma();
    await expect(
      service(prisma).createTopupIntent('c1', 'c1', 10_000_001, { idempotencyKey: 'b-t-max' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each([50, 99, 10_000_001])('retrait %i → 400', async (amount) => {
    const { prisma, store } = mockPrisma();
    credit(store, 'c1', 20_000_000);
    await expect(
      service(prisma).createWithdrawalRequest('c1', 'c1', amount, { idempotencyKey: `b-w-${amount}` }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it.each([100, 10_000_000])('retrait %i → PENDING (fonds suffisants)', async (amount) => {
    const { prisma, store } = mockPrisma();
    credit(store, 'c1', 20_000_000);
    const req = await service(prisma).createWithdrawalRequest('c1', 'c1', amount, {
      idempotencyKey: `ok-w-${amount}`,
    });
    expect(req.status).toBe('PENDING');
  });
});

describe('idempotence : même tentative → même clé, pas de doublon', () => {
  it('même clé, contenu différent → intention existante (zéro doublon)', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    const first = await svc.createTopupIntent('c1', 'c1', 5000, { idempotencyKey: 'idem-1' });
    const replay = await svc.createTopupIntent('c1', 'c1', 9999, { idempotencyKey: 'idem-1' });
    expect(replay.reference).toBe(first.reference);
    expect(store.topups.size).toBe(1);
  });

  it('conflit transaction SasPay déjà consommée → 409', async () => {
    const { prisma } = mockPrisma();
    const svc = service(prisma);
    const a = await svc.createTopupIntent('c1', 'c1', 1000, { idempotencyKey: 'cf-a' });
    const b = await svc.createTopupIntent('c1', 'c1', 1000, { idempotencyKey: 'cf-b' });
    await svc.confirmTopupIntent(a.reference, { saspayTransactionId: 'sp-dup', netAmount: 1000 });
    await expect(
      svc.confirmTopupIntent(b.reference, { saspayTransactionId: 'sp-dup', netAmount: 1000 }),
    ).rejects.toMatchObject({ status: 409 });
  });
});

describe('paiement : statuts PENDING / SUCCESS / FAILED / CANCELLED', () => {
  it('cycle complet sans invention de statut', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    const intent = await svc.createTopupIntent('c1', 'c1', 5000, { idempotencyKey: 'st-1' });
    expect(intent.status).toBe('PENDING');
    expect(store.ledger).toHaveLength(0);

    const ok = await svc.confirmTopupIntent(intent.reference, {
      saspayTransactionId: 'sp-ok', netAmount: 5000,
    });
    expect(ok.intent.status).toBe('SUCCESS');

    const f = await svc.createTopupIntent('c1', 'c1', 1000, { idempotencyKey: 'st-f' });
    expect((await svc.failTopupIntent(f.reference, 'rejet')).status).toBe('FAILED');
    const c = await svc.createTopupIntent('c1', 'c1', 1000, { idempotencyKey: 'st-c' });
    expect((await svc.cancelTopupIntent(c.reference)).status).toBe('CANCELLED');
    expect(store.ledger.filter((t) => t.type === 'CLIENT_TOPUP')).toHaveLength(1);
  });
});

describe('retrait : frais ADD_ON / DEDUCTED exposés (jamais hardcodés)', () => {
  /* OPTION A : le débit suit TOUJOURS le net demandé (= montant du hold),
   * jamais le `chargedAmount`. Débiter le brut majoré porterait les frais
   * SasPay sur le technicien — l'inverse de « Relio absorbe ». Les
   * montants SasPay restent exposés tels quels sur la demande (pour la
   * réconciliation) et tracés en metadata de l'écriture. */
  it('ADD_ON : débit au net (10000), DEDUCTED : idem — frais jamais débités', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    credit(store, 'c1', 50000);
    const ao = await svc.createWithdrawalRequest('c1', 'c1', 10000, { idempotencyKey: 'fee-ao' });
    await svc.settleWithdrawalSuccess(ao.reference, {
      saspayTransactionId: 'po-ao', fee: 200, chargedAmount: 10200,
      netAmount: 10000, feeChargeMode: 'ADD_ON',
    });
    const done = (await svc.getWithdrawalRequestForOwner('c1', ao.reference))!;
    expect(done.feeChargeMode).toBe('ADD_ON');
    expect(done.chargedAmount).toBe(10200);
    expect(done.netAmount).toBe(10000);
    expect(store.ledger.filter((t) => t.type === 'CLIENT_WITHDRAWAL')[0].amount).toBe(10000);

    const ded = await svc.createWithdrawalRequest('c1', 'c1', 10000, { idempotencyKey: 'fee-ded' });
    await svc.settleWithdrawalSuccess(ded.reference, {
      saspayTransactionId: 'po-ded', fee: 150, chargedAmount: 10000,
      netAmount: 9850, feeChargeMode: 'DEDUCTED',
    });
    const doneDed = (await svc.getWithdrawalRequestForOwner('c1', ded.reference))!;
    expect(doneDed.feeChargeMode).toBe('DEDUCTED');
    expect(store.ledger.filter((t) => t.type === 'CLIENT_WITHDRAWAL')[1].amount).toBe(10000);
  });

  it('fonds insuffisants → 400, aucun hold', async () => {
    const { prisma, store } = mockPrisma();
    await expect(
      service(prisma).createWithdrawalRequest('c1', 'c1', 5000, { idempotencyKey: 'fee-poor' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.holds.size).toBe(0);
  });
});
