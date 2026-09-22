import { describe, expect, it, vi } from 'vitest';
import { FinancialService, generateRelioWithdrawalReference } from './financial.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ConfigService } from '@nestjs/config';

/* Sprint ADMIN SUPER POWERS — fonds Relio et retraits (Prisma mocké) :
 * solde disponible, refus de découvert, traçabilité ledger, référence. */

function fundsService(prisma: unknown) {
  const config = { get: vi.fn(() => 'SIMULATION') } as unknown as ConfigService;
  return new FinancialService(prisma as PrismaService, config);
}

function mockLedgerTx(overrides: {
  technicianFees?: number;
  clientFees?: number;
  withdrawn?: number;
  withdrawalsCount?: number;
} = {}) {
  const created: Array<{ data: Record<string, unknown> }> = [];
  const tx = {
    $executeRaw: vi.fn(async () => []),
    financialTransaction: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => {
        created.push(args);
        return { id: `ft-${created.length}`, createdAt: new Date(), ...args.data };
      }),
      aggregate: vi.fn(async (args: { where: { type: string } }) => {
        if (args.where.type === 'TECHNICIAN_FEE')
          return { _sum: { amount: overrides.technicianFees ?? 0 } };
        return { _sum: { amount: overrides.clientFees ?? 0 } };
      }),
    },
    relioWithdrawal: {
      aggregate: vi.fn(async () => ({ _sum: { amount: overrides.withdrawn ?? 0 } })),
      count: vi.fn(async () => overrides.withdrawalsCount ?? 0),
      create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
        id: 'w1',
        createdAt: new Date('2026-09-22T00:00:00Z'),
        requestedBy: { id: 'admin1', firstName: 'Admin', lastName: null },
        ...args.data,
      })),
    },
  };
  return { tx, created };
}

describe('fonds Relio : disponible = acquises − retraits', () => {
  it('commissions technicien + legacy moins retraits', async () => {
    const { tx } = mockLedgerTx({ technicianFees: 4400, clientFees: 100, withdrawn: 1500 });
    const prisma = {
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    };
    const funds = await fundsService(prisma).getRelioFunds();
    expect(funds.acquired).toBe(4500);
    expect(funds.withdrawn).toBe(1500);
    expect(funds.available).toBe(3000);
    expect(funds.currency).toBe('XAF');
  });
});

describe('retraits : protections financières', () => {
  it('montant nul/négatif → 400 ; découvert → 400', async () => {
    const { tx } = mockLedgerTx({ technicianFees: 440 });
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ id: 'admin1', role: 'ADMIN' })) },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    };
    const service = fundsService(prisma);
    await expect(service.withdrawRelioFunds('admin1', 0)).rejects.toMatchObject({ status: 400 });
    await expect(service.withdrawRelioFunds('admin1', -100)).rejects.toMatchObject({ status: 400 });
    await expect(service.withdrawRelioFunds('admin1', 441)).rejects.toMatchObject({ status: 400 });
  });

  it('non-admin → 403 ; écriture ledger créée uniquement en cas de succès', async () => {
    const { tx, created } = mockLedgerTx({ technicianFees: 440 });
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ id: 'c1', role: 'CLIENT' })) },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    };
    await expect(fundsService(prisma).withdrawRelioFunds('c1', 100)).rejects.toMatchObject({
      status: 403,
    });
    expect(created).toHaveLength(0);
  });

  it('retrait valide → ligne RELIO-WD-… + écriture RELIO_WITHDRAWAL + availableAfter', async () => {
    const { tx, created } = mockLedgerTx({ technicianFees: 2200, withdrawn: 1000 });
    const prisma = {
      user: { findUnique: vi.fn(async () => ({ id: 'admin1', role: 'ADMIN' })) },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    };
    const result = await fundsService(prisma).withdrawRelioFunds('admin1', 1000, 'Virement');
    expect(result.reference).toMatch(/^RELIO-WD-[A-HJ-NP-Z0-9]{8}$/);
    expect(result.availableAfter).toBe(200);
    const ledger = created.find((c) => c.data.type === 'RELIO_WITHDRAWAL');
    expect(ledger?.data.direction).toBe('DEBIT');
    expect(ledger?.data.amount).toBe(1000);
    expect(tx.$executeRaw).toHaveBeenCalled();
  });

  it('référence RELIO-WD-… : format et unicité', () => {
    const refs = new Set(Array.from({ length: 200 }, () => generateRelioWithdrawalReference()));
    expect(refs.size).toBe(200);
    for (const ref of refs) {
      expect(ref).toMatch(/^RELIO-WD-[A-HJ-NP-Z0-9]{8}$/);
    }
  });
});
