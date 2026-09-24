import { describe, expect, it, vi } from 'vitest';
import { FinancialService } from './financial.service.js';
import { CollaborationService } from '../collaboration/collaboration.service.js';
import { DemandesService } from '../demandes/demandes.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ConfigService } from '@nestjs/config';

/* Sprint SASPAY-02 — FundsHold branché au cycle mission (Prisma simulé en
 * mémoire, avec rollback transactionnel) :
 *   ACCEPT → hold ACTIVE (aucun débit) → CONFIRMED (hold CONSUMED + débit
 *   client + règlement technicien) ou CANCELED (hold RELEASED, 0 écriture).
 * Aucun appel SasPay, aucun nouveau ledger, historique legacy préservé. */

type Row = Record<string, any>;

const MODE = 'SIMULATION';

function fullDemande(overrides: Row): Row {
  return {
    id: 'm1',
    reference: 'REL-001',
    status: 'ACCEPTED',
    category: 'plomberie',
    description: 'Fuite',
    city: 'Douala',
    cityId: null,
    zoneId: null,
    neighborhood: null,
    address: null,
    landmark: null,
    contactPhone: null,
    clientId: 'c1',
    technicianId: 't1',
    scheduledAt: null,
    requestedMode: 'ASAP',
    requestedAt: null,
    createdAt: new Date(),
    domainId: null,
    brandId: null,
    modelId: null,
    problemId: null,
    negotiationRequestedAt: null,
    finalAmount: null,
    medias: [],
    technician: null,
    domain: null,
    brand: null,
    model: null,
    problem: null,
    ...overrides,
  };
}

function fullQuote(overrides: Row): Row {
  return {
    id: 'q1',
    demandeId: 'm1',
    technicianId: 't1',
    amount: 20000,
    currency: 'XAF',
    description: 'Réparation',
    status: 'PENDING',
    source: 'MANUAL',
    diagnosticId: null,
    catalogDiagnosticId: null,
    catalogInterventionId: null,
    catalogDiagnostic: null,
    catalogIntervention: null,
    diagnostic: null,
    initialReferencePrice: null,
    initialTravelFee: null,
    initialServiceFee: null,
    travelAmount: 2000,
    createdAt: new Date(),
    ...overrides,
  };
}

function mockWorld(seed: { demandes?: Row[]; quotes?: Row[]; ledger?: Row[] } = {}) {
  const users: Record<string, Row> = {
    c1: { id: 'c1', role: 'CLIENT' },
    t1: { id: 't1', role: 'TECHNICIAN' },
  };
  const demandes = new Map<string, Row>(seed.demandes?.map((d) => [d.id, { ...d }]) ?? []);
  const quotes = new Map<string, Row>(seed.quotes?.map((q) => [q.id, { ...q }]) ?? []);
  const ledger: Row[] = (seed.ledger ?? []).map((t) => ({ ...t }));
  const holds = new Map<string, Row>();
  const events: Row[] = [];
  const notifications: Row[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${(seq += 1)}`;

  const matchLedger = (t: Row, where: Row = {}) =>
    (where.userId === undefined || t.userId === where.userId) &&
    (where.mode === undefined || t.mode === where.mode) &&
    (where.status === undefined || t.status === where.status) &&
    (where.direction === undefined || t.direction === where.direction) &&
    (where.type === undefined || t.type === where.type) &&
    (where.demandeId === undefined || t.demandeId === where.demandeId);

  const tx = {
    $executeRaw: vi.fn(async () => []),
    user: { findUnique: vi.fn(async ({ where }: any) => users[where.id] ?? null) },
    quote: {
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const q of quotes.values()) {
          if (
            (where.id === undefined || q.id === where.id) &&
            (where.demandeId === undefined || q.demandeId === where.demandeId) &&
            (where.status === undefined || q.status === where.status)
          ) {
            Object.assign(q, data);
            count += 1;
          }
        }
        return { count };
      }),
      findFirst: vi.fn(async ({ where }: any = {}) => {
        for (const q of quotes.values()) {
          if (
            (where.demandeId === undefined || q.demandeId === where.demandeId) &&
            (where.status === undefined || q.status === where.status) &&
            (where.id === undefined || q.id === where.id)
          ) {
            return { ...q };
          }
        }
        return null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const q = quotes.get(where.id);
        if (!q) throw new Error('not found');
        return { ...q };
      }),
    },
    demande: {
      findUnique: vi.fn(async ({ where }: any) => {
        const d = demandes.get(where.id);
        return d ? { ...d } : null;
      }),
      findFirst: vi.fn(async ({ where }: any = {}) => {
        for (const d of demandes.values()) {
          if (
            (where.id === undefined || d.id === where.id) &&
            (where.clientId === undefined || d.clientId === where.clientId)
          ) {
            return { ...d };
          }
        }
        return null;
      }),
      findFirstOrThrow: vi.fn(async ({ where }: any = {}) => {
        for (const d of demandes.values()) {
          if (
            (where.id === undefined || d.id === where.id) &&
            (where.clientId === undefined || d.clientId === where.clientId) &&
            (where.technicianId === undefined || d.technicianId === where.technicianId)
          ) {
            return { ...d };
          }
        }
        throw new Error('not found');
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const d = demandes.get(where.id);
        if (!d) throw new Error('not found');
        Object.assign(d, data);
        return { ...d };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const d of demandes.values()) {
          if (
            (where.id === undefined || d.id === where.id) &&
            (where.clientId === undefined || d.clientId === where.clientId) &&
            (where.technicianId === undefined || d.technicianId === where.technicianId) &&
            (where.status === undefined || d.status === where.status)
          ) {
            Object.assign(d, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    demandeEvent: { create: vi.fn(async ({ data }: any) => { events.push(data); return data; }) },
    notification: { create: vi.fn(async ({ data }: any) => { notifications.push(data); return data; }) },
    financialTransaction: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.reference) return ledger.find((t) => t.reference === where.reference) ?? null;
        if (where.id) return ledger.find((t) => t.id === where.id) ?? null;
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any = {}) => ledger.find((t) => matchLedger(t, where)) ?? null),
      findMany: vi.fn(async ({ where }: any = {}) => ledger.filter((t) => matchLedger(t, where))),
      create: vi.fn(async ({ data }: any) => {
        if (ledger.some((t) => t.reference === data.reference)) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        const row = { id: nextId('ft'), createdAt: new Date(), status: 'VALIDATED', mode: MODE, ...data };
        ledger.push(row);
        return row;
      }),
      aggregate: vi.fn(async ({ where }: any = {}) => ({
        _sum: { amount: ledger.filter((t) => matchLedger(t, where)).reduce((a, t) => a + t.amount, 0) },
      })),
    },
    fundsHold: {
      findUnique: vi.fn(async ({ where }: any) => holds.get(where.reference) ?? null),
      findFirst: vi.fn(async ({ where }: any = {}) => {
        for (const h of holds.values()) {
          if (
            (where.demandeId === undefined || h.demandeId === where.demandeId) &&
            (where.mode === undefined || h.mode === where.mode) &&
            (where.status === undefined || h.status === where.status)
          ) {
            return { ...h };
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        if (holds.has(data.reference)) {
          throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
        }
        const row = { id: nextId('hold'), createdAt: new Date(), currency: 'XAF', mode: MODE, status: 'ACTIVE', releasedAt: null, ...data };
        holds.set(row.reference, row);
        return { ...row };
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const h of holds.values()) {
          if (
            (where.reference === undefined || h.reference === where.reference) &&
            (where.id === undefined || h.id === where.id) &&
            (where.status === undefined || h.status === where.status)
          ) {
            Object.assign(h, data);
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
    topupIntent: { findUnique: vi.fn(async () => null), findFirst: vi.fn(async () => null) },
    withdrawalRequest: { findUnique: vi.fn(async () => null) },
    relioWithdrawal: { aggregate: vi.fn(async () => ({ _sum: { amount: 0 } })), count: vi.fn(async () => 0) },
  };

  // Transaction avec rollback : snapshot/restaure l'état mutable en cas d'erreur.
  const prisma = {
    ...tx,
    $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => {
      const snapDemandes = new Map([...demandes].map(([k, v]) => [k, { ...v }]));
      const snapQuotes = new Map([...quotes].map(([k, v]) => [k, { ...v }]));
      const snapLedger = ledger.map((t) => ({ ...t }));
      const snapHolds = new Map([...holds].map(([k, v]) => [k, { ...v }]));
      try {
        return await cb(tx);
      } catch (error) {
        demandes.clear();
        for (const [k, v] of snapDemandes) demandes.set(k, v);
        quotes.clear();
        for (const [k, v] of snapQuotes) quotes.set(k, v);
        ledger.length = 0;
        ledger.push(...snapLedger);
        holds.clear();
        for (const [k, v] of snapHolds) holds.set(k, v);
        throw error;
      }
    }),
  };
  const config = { get: vi.fn(() => MODE) } as unknown as ConfigService;
  const financial = new FinancialService(prisma as unknown as PrismaService, config);
  const collaboration = new CollaborationService(prisma as unknown as PrismaService, financial);
  const demandesService = new DemandesService(
    prisma as unknown as PrismaService,
    financial,
    {} as never,
  );
  const clientUser = { id: 'c1', role: 'CLIENT' } as const;
  return { prisma, tx, financial, collaboration, demandesService, clientUser, store: { demandes, quotes, ledger, holds, events, notifications } };
}

function creditLedger(store: { ledger: Row[] }, entry: Row) {
  store.ledger.push({ id: `seed-${store.ledger.length}`, createdAt: new Date(), status: 'VALIDATED', mode: MODE, ...entry });
}

describe('ACCEPT : hold ACTIVE, aucun débit', () => {
  it('fonds suffisants → ACCEPTED + 1 hold brut + finalAmount, 0 écriture ledger', async () => {
    const { collaboration, clientUser, store } = mockWorld({
      demandes: [fullDemande({})],
      quotes: [fullQuote({})],
    });
    creditLedger(store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 50000, reference: 'seed-topup' });

    const result = await collaboration.respondToQuote(clientUser as never, 'm1', 'q1', 'accept');
    expect(result.status).toBe('ACCEPTED');
    const hold = store.holds.get('mission-hold:m1:SIMULATION');
    expect(hold?.status).toBe('ACTIVE');
    expect(hold?.amount).toBe(22000);
    expect(hold?.demandeId).toBe('m1');
    expect(store.ledger.filter((t) => t.type === 'CLIENT_MISSION_DEBIT')).toHaveLength(0);
    expect(store.demandes.get('m1')?.finalAmount).toBe(22000);
    expect(store.events.some((e) => e.type === 'QUOTE_ACCEPTED')).toBe(true);
  });

  it('fonds insuffisants → 400 INSUFFICIENT_FUNDS, devis resté PENDING, aucun hold, aucun ledger', async () => {
    const { collaboration, clientUser, store } = mockWorld({
      demandes: [fullDemande({})],
      quotes: [fullQuote({})],
    });
    creditLedger(store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 5000, reference: 'seed-topup' });

    const error = await collaboration.respondToQuote(clientUser as never, 'm1', 'q1', 'accept').catch((e) => e);
    expect(error.status).toBe(400);
    expect(error.response).toMatchObject({ code: 'INSUFFICIENT_FUNDS', required: 22000, available: 5000, currency: 'XAF' });
    expect(store.quotes.get('q1')?.status).toBe('PENDING');
    expect(store.holds.size).toBe(0);
    expect(store.ledger.filter((t) => t.type === 'CLIENT_MISSION_DEBIT')).toHaveLength(0);
  });

  it('retry acceptation → 409, toujours 1 seul hold', async () => {
    const { collaboration, clientUser, store } = mockWorld({
      demandes: [fullDemande({})],
      quotes: [fullQuote({})],
    });
    creditLedger(store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 50000, reference: 'seed-topup' });
    await collaboration.respondToQuote(clientUser as never, 'm1', 'q1', 'accept');
    await expect(collaboration.respondToQuote(clientUser as never, 'm1', 'q1', 'accept')).rejects.toMatchObject({ status: 409 });
    expect(store.holds.size).toBe(1);
  });

  it('deux missions, même solde → les holds cumulés ne dépassent jamais le disponible', async () => {
    const world = mockWorld({
      demandes: [fullDemande({ id: 'm1' }), fullDemande({ id: 'm2', reference: 'REL-002' })],
      quotes: [fullQuote({ id: 'q1', demandeId: 'm1' }), fullQuote({ id: 'q2', demandeId: 'm2', amount: 20000 })],
    });
    creditLedger(world.store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 25000, reference: 'seed-topup' });
    await world.collaboration.respondToQuote(world.clientUser as never, 'm1', 'q1', 'accept');
    await expect(world.collaboration.respondToQuote(world.clientUser as never, 'm2', 'q2', 'accept')).rejects.toMatchObject({ status: 400 });
    expect(world.store.holds.size).toBe(1);
  });
});

describe('CONFIRMED : hold CONSUMED + débit définitif + règlement unique', () => {
  async function acceptFirst() {
    const world = mockWorld({
      demandes: [fullDemande({ status: 'COMPLETED' })],
      quotes: [fullQuote({ status: 'ACCEPTED' })],
    });
    creditLedger(world.store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 50000, reference: 'seed-topup' });
    // Hold créé comme à l'acceptation (mission déjà acceptée ici).
    await world.financial.holdClientAtAcceptance(world.tx as never, {
      demandeId: 'm1',
      clientId: 'c1',
      quote: { id: 'q1', amount: 20000, travelAmount: 2000, initialTravelFee: null },
      actorUserId: 'c1',
    });
    return world;
  }

  it('CONFIRMED → CONSUMED + CLIENT_MISSION_DEBIT + repair/travel/fee (440 = 2 % de 22000)', async () => {
    const world = await acceptFirst();
    await world.demandesService.updateStatus('c1', 'm1', { status: 'CONFIRMED' } as never);
    expect(world.store.holds.get('mission-hold:m1:SIMULATION')?.status).toBe('CONSUMED');
    const debits = world.store.ledger.filter((t) => t.type === 'CLIENT_MISSION_DEBIT');
    expect(debits).toHaveLength(1);
    expect(debits[0].amount).toBe(22000);
    expect(world.store.ledger.find((t) => t.type === 'TECHNICIAN_REPAIR_REVENUE')?.amount).toBe(20000);
    expect(world.store.ledger.find((t) => t.type === 'TECHNICIAN_TRAVEL_REVENUE')?.amount).toBe(2000);
    expect(world.store.ledger.find((t) => t.type === 'TECHNICIAN_FEE')?.amount).toBe(440);
  });

  it('CONFIRMED répété au niveau service → aucun doublon', async () => {
    const world = await acceptFirst();
    const args = { demandeId: 'm1', clientId: 'c1', technicianId: 't1', createdById: 'c1' };
    await world.financial.settleMissionAtConfirmation(world.tx as never, args);
    await world.financial.settleMissionAtConfirmation(world.tx as never, args);
    expect(world.store.ledger.filter((t) => t.type === 'CLIENT_MISSION_DEBIT')).toHaveLength(1);
    expect(world.store.ledger.filter((t) => t.type === 'TECHNICIAN_FEE')).toHaveLength(1);
  });

  it('mission legacy (débit historique, sans hold) → pas de doublon de débit, règlement inchangé', async () => {
    const world = mockWorld({
      demandes: [fullDemande({ status: 'COMPLETED' })],
      quotes: [fullQuote({ status: 'ACCEPTED' })],
    });
    creditLedger(world.store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 50000, reference: 'seed-topup' });
    creditLedger(world.store, { userId: 'c1', demandeId: 'm1', type: 'CLIENT_MISSION_DEBIT', direction: 'DEBIT', amount: 22000, reference: 'client-mission-debit:m1:q1:SIMULATION' });
    await world.demandesService.updateStatus('c1', 'm1', { status: 'CONFIRMED' } as never);
    expect(world.store.ledger.filter((t) => t.type === 'CLIENT_MISSION_DEBIT')).toHaveLength(1);
    expect(world.store.holds.size).toBe(0);
    expect(world.store.ledger.filter((t) => t.type === 'TECHNICIAN_FEE')).toHaveLength(1);
  });
});

describe('CANCELED : hold RELEASED, aucun faux remboursement', () => {
  it('hold ACTIVE → RELEASED, 0 écriture (ni TOPUP, ni REVERSAL), disponible restauré', async () => {
    const world = mockWorld({
      demandes: [fullDemande({ status: 'SCHEDULED' })],
      quotes: [fullQuote({ status: 'ACCEPTED' })],
    });
    creditLedger(world.store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 50000, reference: 'seed-topup' });
    await world.financial.holdClientAtAcceptance(world.tx as never, {
      demandeId: 'm1', clientId: 'c1',
      quote: { id: 'q1', amount: 20000, travelAmount: 2000, initialTravelFee: null },
      actorUserId: 'c1',
    });
    expect(await world.financial.getAvailableBalance('c1', 'SIMULATION')).toBe(28000);

    await world.demandesService.updateStatus('c1', 'm1', { status: 'CANCELED' } as never);
    expect(world.store.holds.get('mission-hold:m1:SIMULATION')?.status).toBe('RELEASED');
    // Aucune NOUVELLE écriture liée à l'annulation (le seed de financement
    // initial est exclu du comptage) : ni topup, ni reversal.
    expect(world.store.ledger.filter((t) => t.type === 'CLIENT_TOPUP' && !String(t.reference).startsWith('seed-'))).toHaveLength(0);
    expect(world.store.ledger.filter((t) => t.type === 'REVERSAL')).toHaveLength(0);
    expect(await world.financial.getAvailableBalance('c1', 'SIMULATION')).toBe(50000);
  });

  it('annulation répétée au niveau service → un seul release, toujours 0 écriture', async () => {
    const world = mockWorld({ demandes: [fullDemande({})], quotes: [fullQuote({ status: 'ACCEPTED' })] });
    creditLedger(world.store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 50000, reference: 'seed-topup' });
    await world.financial.holdClientAtAcceptance(world.tx as never, {
      demandeId: 'm1', clientId: 'c1',
      quote: { id: 'q1', amount: 20000, travelAmount: 2000, initialTravelFee: null },
      actorUserId: 'c1',
    });
    await world.financial.releaseMissionHoldIfAny(world.tx as never, { demandeId: 'm1' });
    await world.financial.releaseMissionHoldIfAny(world.tx as never, { demandeId: 'm1' });
    expect(world.store.holds.get('mission-hold:m1:SIMULATION')?.status).toBe('RELEASED');
    expect(world.store.ledger).toHaveLength(1);
  });

  it('mission legacy avec débit historique → REVERSAL préservée', async () => {
    const world = mockWorld({ demandes: [fullDemande({ status: 'SCHEDULED' })], quotes: [fullQuote({ status: 'ACCEPTED' })] });
    creditLedger(world.store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 50000, reference: 'seed-topup' });
    creditLedger(world.store, { userId: 'c1', demandeId: 'm1', type: 'CLIENT_MISSION_DEBIT', direction: 'DEBIT', amount: 22000, reference: 'client-mission-debit:m1:q1:SIMULATION' });
    await world.demandesService.updateStatus('c1', 'm1', { status: 'CANCELED' } as never);
    const reversals = world.store.ledger.filter((t) => t.type === 'REVERSAL');
    expect(reversals).toHaveLength(1);
    expect(reversals[0].direction).toBe('CREDIT');
    expect(reversals[0].amount).toBe(22000);
  });
});

describe('concurrence CONFIRMED / CANCELED', () => {
  it('CONFIRMED puis CANCELED → 400, livres cohérents (débit + technicien, hold CONSUMED)', async () => {
    const world = mockWorld({
      demandes: [fullDemande({ status: 'COMPLETED' })],
      quotes: [fullQuote({ status: 'ACCEPTED' })],
    });
    creditLedger(world.store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 50000, reference: 'seed-topup' });
    await world.financial.holdClientAtAcceptance(world.tx as never, {
      demandeId: 'm1', clientId: 'c1',
      quote: { id: 'q1', amount: 20000, travelAmount: 2000, initialTravelFee: null },
      actorUserId: 'c1',
    });
    await world.demandesService.updateStatus('c1', 'm1', { status: 'CONFIRMED' } as never);
    await expect(world.demandesService.updateStatus('c1', 'm1', { status: 'CANCELED' } as never)).rejects.toMatchObject({ status: 400 });
    // Aucune écriture supplémentaire : pas de REVERSAL abusive, hold resté CONSUMED.
    expect(world.store.ledger.filter((t) => t.type === 'REVERSAL')).toHaveLength(0);
    expect(world.store.holds.get('mission-hold:m1:SIMULATION')?.status).toBe('CONSUMED');
    expect(world.store.ledger.filter((t) => t.type === 'CLIENT_MISSION_DEBIT')).toHaveLength(1);
  });

  it('règlement puis release → le hold CONSUMED ne régresse jamais', async () => {
    const world = mockWorld({ demandes: [fullDemande({})], quotes: [fullQuote({ status: 'ACCEPTED' })] });
    creditLedger(world.store, { userId: 'c1', type: 'CLIENT_TOPUP', direction: 'CREDIT', amount: 50000, reference: 'seed-topup' });
    await world.financial.holdClientAtAcceptance(world.tx as never, {
      demandeId: 'm1', clientId: 'c1',
      quote: { id: 'q1', amount: 20000, travelAmount: 2000, initialTravelFee: null },
      actorUserId: 'c1',
    });
    await world.financial.settleMissionAtConfirmation(world.tx as never, {
      demandeId: 'm1', clientId: 'c1', technicianId: 't1', createdById: 'c1',
    });
    const released = await world.financial.releaseMissionHoldIfAny(world.tx as never, { demandeId: 'm1' });
    expect(released?.status).toBe('CONSUMED');
  });
});
