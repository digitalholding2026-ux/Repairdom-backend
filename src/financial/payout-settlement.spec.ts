import { describe, expect, it, vi } from 'vitest';
import { FinancialService } from './financial.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ConfigService } from '@nestjs/config';

/* Sprint PAYOUT — règlement des retraits (Prisma simulé en mémoire) :
 * hold ACTIVE à la création, débit définitif unique au `charged` constaté
 * (jamais de frais calculés), hold CONSUMED au SUCCESS / RELEASED sinon,
 * séparation CLIENT_/TECHNICIAN_WITHDRAWAL, idempotence stricte. */

type Row = Record<string, any>;

function mockPrisma(
  users: Record<string, { id: string; role: string }> = {
    c1: { id: 'c1', role: 'CLIENT' },
    t1: { id: 't1', role: 'TECHNICIAN' },
  },
  mode = 'SIMULATION',
) {
  const ledger: Row[] = [];
  const withdrawals = new Map<string, Row>();
  const withdrawalsByKey = new Map<string, Row>();
  const holds = new Map<string, Row>();
  let seq = 0;
  const nextId = (p: string) => `${p}-${(seq += 1)}`;

  const tx = {
    $executeRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async ({ where }: any) => users[where.id] ?? null) },
    financialTransaction: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.reference) return ledger.find((t) => t.reference === where.reference) ?? null;
        if (where.id) return ledger.find((t) => t.id === where.id) ?? null;
        return null;
      }),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => {
        if (ledger.some((t) => t.reference === data.reference)) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        const row = { id: nextId('ft'), createdAt: new Date(), status: 'VALIDATED', mode, ...data };
        ledger.push(row);
        return row;
      }),
      aggregate: vi.fn(async ({ where }: any = {}) => ({
        _sum: {
          amount: ledger
            .filter(
              (t) =>
                (where.userId === undefined || t.userId === where.userId) &&
                (where.mode === undefined || t.mode === where.mode) &&
                (where.status === undefined || t.status === where.status) &&
                (where.direction === undefined || t.direction === where.direction) &&
                (where.type === undefined || t.type === where.type),
            )
            .reduce((a, t) => a + t.amount, 0),
        },
      })),
    },
    withdrawalRequest: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.reference) return withdrawals.get(where.reference) ?? null;
        if (where.idempotencyKey) return withdrawalsByKey.get(where.idempotencyKey) ?? null;
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any = {}) => {
        if (where.saspayTransactionId !== undefined) {
          return (
            [...withdrawals.values()].find((w) => w.saspayTransactionId === where.saspayTransactionId) ?? null
          );
        }
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
        const row = [...withdrawals.values()].find((w) => w.id === where.id || w.reference === where.reference);
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
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const row of holds.values()) {
          if (
            (where.id === undefined || row.id === where.id) &&
            (where.reference === undefined || row.reference === where.reference) &&
            (where.status === undefined || row.status === where.status)
          ) {
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
  return { prisma, tx, store: { ledger, withdrawals, holds } };
}

function service(prisma: unknown, financialMode = 'SIMULATION') {
  const config = { get: vi.fn((key: string) => (key === 'FINANCIAL_MODE' ? financialMode : undefined)) } as unknown as ConfigService;
  return new FinancialService(prisma as PrismaService, config);
}

function creditLedger(store: { ledger: Row[] }, entry: Row) {
  store.ledger.push({ id: `seed-${store.ledger.length}`, createdAt: new Date(), status: 'VALIDATED', mode: MODE, ...entry });
}

const MODE = 'SIMULATION';

describe('création : hold + validation réseau/bénéficiaire', () => {
  it('crée hold ACTIVE + PENDING, réseau/pays/msisdn conservés, aucun débit', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    creditLedger(store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 20000, reference: 'seed' });
    const req = await svc.createWithdrawalRequest('c1', 'c1', 5000, {
      idempotencyKey: 'w-1',
      network: 'mtn_cm',
      msisdn: '+237 677 88 99 00',
    });
    expect(req.status).toBe('PENDING');
    expect(req.network).toBe('mtn_cm');
    expect(req.country).toBe('CM');
    expect(store.holds.size).toBe(1);
    expect([...store.holds.values()][0].status).toBe('ACTIVE');
    expect([...store.holds.values()][0].amount).toBe(5000);
    expect((store.withdrawals.get(req.reference)?.metadata as Row)?.msisdn).toBe('+237677889900');
    expect(store.ledger.filter((t) => t.type === 'CLIENT_WITHDRAWAL')).toHaveLength(0);
    expect(await svc.getAvailableBalance('c1', 'SIMULATION')).toBe(15000);
  });

  it('réseau hors référentiel → 400 ; msisdn invalide → 400 ; aucun hold', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    await expect(
      svc.createWithdrawalRequest('c1', 'c1', 5000, { idempotencyKey: 'w-x1', network: 'eu_mobile_cm' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      svc.createWithdrawalRequest('c1', 'c1', 5000, { idempotencyKey: 'w-x2', network: 'mtn_cm', msisdn: '12' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.holds.size).toBe(0);
  });

  it('fonds insuffisants → 400, aucun hold, aucun débit', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    await expect(
      svc.createWithdrawalRequest('c1', 'c1', 5000, { idempotencyKey: 'w-poor' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(store.holds.size).toBe(0);
  });

  it('même clé → une seule demande, un seul hold (pas de double verrou)', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    creditLedger(store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 20000, reference: 'seed' });
    const a = await svc.createWithdrawalRequest('c1', 'c1', 5000, { idempotencyKey: 'w-dup' });
    const b = await svc.createWithdrawalRequest('c1', 'c1', 9999, { idempotencyKey: 'w-dup' });
    expect(a.reference).toBe(b.reference);
    expect(store.withdrawals.size).toBe(1);
    expect(store.holds.size).toBe(1);
  });
});

describe('SUCCESS : débit unique au charged constaté', () => {
  it('DEDUCTED (charged=requested) → débit 10000 + CONSUMED + refs, replay sans doublon', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    creditLedger(store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 20000, reference: 'seed' });
    const req = await svc.createWithdrawalRequest('c1', 'c1', 10000, { idempotencyKey: 'w-ok' });
    const holdId = req.holdId as string;

    const first = await svc.settleWithdrawalSuccess(req.reference, {
      saspayTransactionId: 'po-1',
      saspayReference: 'TXN-W1',
      network: 'mtn_cm',
      country: 'CM',
      fee: 150,
      chargedAmount: 10000,
      netAmount: 9850,
      feeChargeMode: 'DEDUCTED',
    });
    expect(first.debited).toBe(true);
    const debits = store.ledger.filter((t) => t.type === 'CLIENT_WITHDRAWAL');
    expect(debits).toHaveLength(1);
    expect(debits[0].amount).toBe(10000);
    expect(debits[0].metadata).toMatchObject({ fee: 150, chargedAmount: 10000, netAmount: 9850 });
    expect([...store.holds.values()].find((h) => h.id === holdId)?.status).toBe('CONSUMED');
    expect(store.withdrawals.get(req.reference)?.status).toBe('SUCCESS');
    expect(store.withdrawals.get(req.reference)?.fee).toBe(150);

    const second = await svc.settleWithdrawalSuccess(req.reference, { saspayTransactionId: 'po-1' });
    expect(second.debited).toBe(false);
    expect(store.ledger.filter((t) => t.type === 'CLIENT_WITHDRAWAL')).toHaveLength(1);
  });

  it('ADD_ON (charged > requested) → débit au charged, jamais de frais calculés', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    creditLedger(store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 20000, reference: 'seed' });
    const req = await svc.createWithdrawalRequest('c1', 'c1', 10000, { idempotencyKey: 'w-ao' });
    await svc.settleWithdrawalSuccess(req.reference, {
      saspayTransactionId: 'po-2',
      fee: 200,
      chargedAmount: 10200,
      netAmount: 10000,
      feeChargeMode: 'ADD_ON',
    });
    expect(store.ledger.filter((t) => t.type === 'CLIENT_WITHDRAWAL')[0].amount).toBe(10200);
  });

  it('sans montants SasPay → débit au requested', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    creditLedger(store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 20000, reference: 'seed' });
    const req = await svc.createWithdrawalRequest('c1', 'c1', 5000, { idempotencyKey: 'w-plain' });
    await svc.settleWithdrawalSuccess(req.reference, { saspayTransactionId: 'po-3' });
    expect(store.ledger.filter((t) => t.type === 'CLIENT_WITHDRAWAL')[0].amount).toBe(5000);
  });

  it('TECHNICIAN → TECHNICIAN_WITHDRAWAL (séparation des rôles)', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    creditLedger(store, { userId: 't1', type: 'TECHNICIAN_REPAIR_REVENUE', direction: 'CREDIT', amount: 30000, reference: 'seed' });
    const req = await svc.createWithdrawalRequest('t1', 't1', 8000, { idempotencyKey: 'w-tech' });
    await svc.settleWithdrawalSuccess(req.reference, { saspayTransactionId: 'po-4', chargedAmount: 8000, netAmount: 7850, fee: 150 });
    expect(store.ledger.filter((t) => t.type === 'TECHNICIAN_WITHDRAWAL')).toHaveLength(1);
    expect(store.ledger.filter((t) => t.type === 'CLIENT_WITHDRAWAL')).toHaveLength(0);
  });
});

describe('FAILED / CANCELLED : hold libéré, aucun débit', () => {
  it('FAILED → RELEASED + raison conservée, 0 écriture ; replay idempotent', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    creditLedger(store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 20000, reference: 'seed' });
    const req = await svc.createWithdrawalRequest('c1', 'c1', 5000, { idempotencyKey: 'w-f' });
    const failed = await svc.settleWithdrawalFailure(req.reference, 'FAILED', 'rejet opérateur');
    expect(failed.status).toBe('FAILED');
    expect(failed.errorMessage).toBe('rejet opérateur');
    expect(failed.userMessage).toMatch(/pas abouti/);
    expect([...store.holds.values()][0].status).toBe('RELEASED');
    expect(store.ledger).toHaveLength(1);
    expect(await svc.getAvailableBalance('c1', 'SIMULATION')).toBe(20000);
    const replay = await svc.settleWithdrawalFailure(req.reference, 'FAILED', 'autre');
    expect(replay.status).toBe('FAILED');
  });

  it('CANCELLED → RELEASED, 0 écriture', async () => {
    const { prisma, store } = mockPrisma();
    const svc = service(prisma);
    creditLedger(store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 20000, reference: 'seed' });
    const req = await svc.createWithdrawalRequest('c1', 'c1', 5000, { idempotencyKey: 'w-c' });
    expect((await svc.settleWithdrawalFailure(req.reference, 'CANCELLED')).status).toBe('CANCELLED');
    expect(store.ledger).toHaveLength(1);
  });

  it('rattachement par transaction SasPay ; inconnue → 404', async () => {
    const { prisma } = mockPrisma();
    const svc = service(prisma);
    await expect(svc.failWithdrawalFromSasPay({ saspayTransactionId: 'po-zzz' })).rejects.toMatchObject({ status: 404 });
    await expect(svc.cancelWithdrawalFromSasPay({})).rejects.toMatchObject({ status: 404 });
  });
});
