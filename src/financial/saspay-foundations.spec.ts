import { describe, expect, it, vi } from 'vitest';
import {
  FinancialService,
  generateFundsHoldReference,
  generateTopupReference,
  generateWithdrawalRequestReference,
} from './financial.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ConfigService } from '@nestjs/config';

/* Sprint SASPAY-01 — fondations : recharge CLIENT_TOPUP, holds, retraits,
 * verrouillage, idempotence, garde REAL. Prisma simulé en mémoire. */

type Row = Record<string, any>;

function mockPrisma(
  users: Record<string, { id: string; role: string }> = {
    c1: { id: 'c1', role: 'CLIENT' },
    t1: { id: 't1', role: 'TECHNICIAN' },
    admin1: { id: 'admin1', role: 'ADMIN' },
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
          network: null, country: null, fee: null, chargedAmount: null, netAmount: null,
          creditedTransactionId: null, errorMessage: null,
          ...data,
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
          network: null, country: null, fee: null, chargedAmount: null, netAmount: null,
          errorMessage: null, ...data,
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
    relioWithdrawal: {
      aggregate: vi.fn(async () => ({ _sum: { amount: 0 } })),
      count: vi.fn(async () => 0),
      create: vi.fn(async ({ data }: any) => ({ id: nextId('rw'), createdAt: new Date(), ...data })),
    },
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
  };
  return { prisma, tx, store: { ledger, topups, withdrawals, holds } };
}

function service(prisma: unknown, financialMode = 'SIMULATION') {
  const config = { get: vi.fn((key: string) => (key === 'FINANCIAL_MODE' ? financialMode : undefined)) } as unknown as ConfigService;
  return new FinancialService(prisma as PrismaService, config);
}

describe('garde REAL : crédit de test refusé', () => {
  it('createTestCredit en REAL → 403, aucune écriture', async () => {
    const { prisma, store } = mockPrisma();
    await expect(service(prisma, 'REAL').createTestCredit('admin1', 'c1', 50000)).rejects.toMatchObject({ status: 403 });
    expect(store.ledger).toHaveLength(0);
  });
});

describe('recharge CLIENT_TOPUP : intention puis confirmation', () => {
  it('création PENDING sans écriture ledger ; confirmation → 1 crédit ; rejouée → aucun doublon', async () => {
    const { prisma, tx, store } = mockPrisma();
    const svc = service(prisma);
    const intent = await svc.createTopupIntent('c1', 'c1', 5000, { idempotencyKey: 'key-1' });
    expect(intent.status).toBe('PENDING');
    expect(store.ledger).toHaveLength(0);

    // Rejeu même clé → même intention, sans doublon.
    const replay = await svc.createTopupIntent('c1', 'c1', 9999, { idempotencyKey: 'key-1' });
    expect(replay.reference).toBe(intent.reference);
    expect(store.topups.size).toBe(1);

    const first = await svc.confirmTopupIntent(intent.reference, { saspayTransactionId: 'sp-1', netAmount: 5000 });
    expect(first.credited).toBe(true);
    expect(store.ledger.filter((t) => t.type === 'CLIENT_TOPUP')).toHaveLength(1);

    const second = await svc.confirmTopupIntent(intent.reference, { saspayTransactionId: 'sp-1', netAmount: 5000 });
    expect(second.credited).toBe(false);
    expect(store.ledger.filter((t) => t.type === 'CLIENT_TOPUP')).toHaveLength(1);
    expect(tx.$executeRaw).toHaveBeenCalled();
  });

  it('saspayTransactionId déjà consommé ailleurs → 409', async () => {
    const { prisma } = mockPrisma();
    const svc = service(prisma);
    const a = await svc.createTopupIntent('c1', 'c1', 1000, { idempotencyKey: 'k-a' });
    const b = await svc.createTopupIntent('c1', 'c1', 1000, { idempotencyKey: 'k-b' });
    await svc.confirmTopupIntent(a.reference, { saspayTransactionId: 'sp-dup' });
    await expect(svc.confirmTopupIntent(b.reference, { saspayTransactionId: 'sp-dup' })).rejects.toMatchObject({ status: 409 });
  });

  it('fail → FAILED sans ledger ; cancel → CANCELLED sans ledger', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    const a = await svc.createTopupIntent('c1', 'c1', 1000, { idempotencyKey: 'k-f' });
    expect((await svc.failTopupIntent(a.reference, 'échec')).status).toBe('FAILED');
    const b = await svc.createTopupIntent('c1', 'c1', 1000, { idempotencyKey: 'k-c' });
    expect((await svc.cancelTopupIntent(b.reference)).status).toBe('CANCELLED');
    expect(store.ledger).toHaveLength(0);
  });
});

describe('réservation : disponible = ledger − holds ACTIVE', () => {
  it('hold réduit le disponible ; release le rend ; double réservation du même disponible → 400', async () => {
    const { prisma } = mockPrisma();
    const svc = service(prisma);
    // Solde ledger 10 000 (topup confirmée).
    const intent = await svc.createTopupIntent('c1', 'c1', 10000, { idempotencyKey: 'k-top' });
    await svc.confirmTopupIntent(intent.reference, {});
    expect(await svc.getAvailableBalance('c1', 'SIMULATION')).toBe(10000);

    await svc.reserveFunds('c1', 6000, { reference: 'hold:m1:c1:SIMULATION', demandeId: 'm1' });
    expect(await svc.getAvailableBalance('c1', 'SIMULATION')).toBe(4000);

    await expect(
      svc.reserveFunds('c1', 5000, { reference: 'hold:m2:c1:SIMULATION', demandeId: 'm2' }),
    ).rejects.toMatchObject({ status: 400 });

    await svc.releaseHold('hold:m1:c1:SIMULATION');
    expect(await svc.getAvailableBalance('c1', 'SIMULATION')).toBe(10000);
  });

  it('réserve idempotente par référence (rejouée → même hold)', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    const intent = await svc.createTopupIntent('c1', 'c1', 10000, { idempotencyKey: 'k-t2' });
    await svc.confirmTopupIntent(intent.reference, {});
    const h1 = await svc.reserveFunds('c1', 1000, { reference: 'hold:x:c1:SIMULATION' });
    const h2 = await svc.reserveFunds('c1', 1000, { reference: 'hold:x:c1:SIMULATION' });
    expect(h1.id).toBe(h2.id);
    expect(store.holds.size).toBe(1);
  });
});

describe('retraits client : PENDING → SUCCESS (débit) ou FAILED (libéré)', () => {
  it('création → hold ACTIVE + PENDING ; SUCCESS → débit + CONSUMED ; FAILED → libéré sans ledger', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    const intent = await svc.createTopupIntent('c1', 'c1', 10000, { idempotencyKey: 'k-t3' });
    await svc.confirmTopupIntent(intent.reference, {});

    const req = await svc.createWithdrawalRequest('c1', 'c1', 3000, { idempotencyKey: 'w-1' });
    expect(req.status).toBe('PENDING');
    expect(store.holds.size).toBe(1);
    expect(await svc.getAvailableBalance('c1', 'SIMULATION')).toBe(7000);

    const ok = await svc.settleWithdrawalSuccess(req.reference, { saspayTransactionId: 'pay-1' });
    expect(ok.debited).toBe(true);
    expect(store.ledger.some((t) => t.type === 'CLIENT_WITHDRAWAL' && t.amount === 3000)).toBe(true);
    // Rejeu du SUCCESS → aucun second débit.
    const replay = await svc.settleWithdrawalSuccess(req.reference, { saspayTransactionId: 'pay-1' });
    expect(replay.debited).toBe(false);
    expect(store.ledger.filter((t) => t.type === 'CLIENT_WITHDRAWAL')).toHaveLength(1);

    const req2 = await svc.createWithdrawalRequest('c1', 'c1', 1000, { idempotencyKey: 'w-2' });
    const failed = await svc.settleWithdrawalFailure(req2.reference, 'FAILED', 'fonds rejetés');
    expect(failed.status).toBe('FAILED');
    expect(store.ledger.filter((t) => t.type === 'CLIENT_WITHDRAWAL')).toHaveLength(1);
    expect(await svc.getAvailableBalance('c1', 'SIMULATION')).toBe(7000);
  });

  it('retrait supérieur au disponible → 400, aucun hold', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    await expect(svc.createWithdrawalRequest('c1', 'c1', 5000, { idempotencyKey: 'w-3' })).rejects.toMatchObject({ status: 400 });
    expect(store.holds.size).toBe(0);
  });
});

describe('références : format et unicité', () => {
  it('TOPUP-/WD-/HOLD- : préfixes, longueurs, 200 uniques', () => {
    const tops = new Set(Array.from({ length: 200 }, () => generateTopupReference()));
    const wds = new Set(Array.from({ length: 200 }, () => generateWithdrawalRequestReference()));
    const holds = new Set(Array.from({ length: 200 }, () => generateFundsHoldReference()));
    expect(tops.size).toBe(200);
    expect(wds.size).toBe(200);
    expect(holds.size).toBe(200);
    for (const r of tops) expect(r).toMatch(/^TOPUP-[A-HJ-NP-Z0-9]{12}$/);
    for (const r of wds) expect(r).toMatch(/^WD-[A-HJ-NP-Z0-9]{12}$/);
    for (const r of holds) expect(r).toMatch(/^HOLD-[A-HJ-NP-Z0-9]{12}$/);
  });
});
