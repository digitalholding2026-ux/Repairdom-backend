import { describe, expect, it, vi } from 'vitest';
import { CollaborationService } from './collaboration.service.js';

/* Correctif post-audit — couverture Quotes/collaboration (aucune spec
 * dédiée auparavant) : création MANUAL/CATALOG, bornes, acceptation,
 * double acceptation, négociation, QuoteSource, garde IA-6 best-effort.
 * Comportement métier inchangé, uniquement vérifié. */

type Row = Record<string, any>;

const DEMANDE: Row = {
  id: 'm1',
  status: 'ACCEPTED',
  clientId: 'c1',
  technicianId: 't1',
  negotiationRequestedAt: null,
};

function fullQuote(overrides: Row): Row {
  return {
    id: 'q1',
    demandeId: 'm1',
    technicianId: 't1',
    amount: 20000,
    currency: 'XAF',
    description: 'Réparation robinet',
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

function quoteService(options: {
  demande?: Row | null;
  quotes?: Row[];
  catalogFlow?: boolean;
  claimCount?: number;
} = {}) {
  const quotes = new Map<string, Row>((options.quotes ?? []).map((q) => [q.id, { ...q }]));
  const events: Row[] = [];
  const notifications: Row[] = [];
  const tx: any = {
    quote: {
      findFirst: vi.fn(async ({ where }: any = {}) => {
        for (const q of quotes.values()) {
          if (
            (where.id === undefined || q.id === where.id) &&
            (where.demandeId === undefined || q.demandeId === where.demandeId) &&
            (where.status === undefined || q.status === where.status)
          ) {
            return { ...q };
          }
        }
        return null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        if (options.claimCount !== undefined) return { count: options.claimCount };
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
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const q = quotes.get(where.id);
        if (!q) throw new Error('not found');
        return { ...q };
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = fullQuote({ id: `q-${quotes.size + 1}`, createdAt: new Date(), ...data });
        quotes.set(row.id, row);
        return { ...row };
      }),
    },
    diagnostic: { findFirst: vi.fn(async () => null), count: vi.fn(async () => (options.catalogFlow ? 1 : 0)) },
    demande: {
      update: vi.fn(async ({ where, data }: any) => {
        if (where.id !== 'm1') throw new Error('not found');
        return { id: 'm1', negotiationRequestedAt: new Date(), ...data };
      }),
    },
    demandeEvent: { create: vi.fn(async ({ data }: any) => { events.push(data); return data; }) },
    notification: { create: vi.fn(async ({ data }: any) => { notifications.push(data); return data; }) },
  };
  const prisma: any = {
    demande: {
      findUnique: vi.fn(async () =>
        options.demande === undefined ? { ...DEMANDE } : options.demande ? { ...options.demande } : null,
      ),
    },
    diagnostic: { count: vi.fn(async () => (options.catalogFlow ? 1 : 0)) },
    quote: {
      findFirst: vi.fn(async ({ where }: any = {}) => {
        for (const q of quotes.values()) {
          if (
            (where.id === undefined || q.id === where.id) &&
            (where.demandeId === undefined || q.demandeId === where.demandeId) &&
            (where.status === undefined || q.status === where.status) &&
            (where.source === undefined || q.source === where.source)
          ) {
            return { ...q };
          }
        }
        return null;
      }),
    },
    demandeEvent: tx.demandeEvent,
    notification: tx.notification,
    $transaction: vi.fn(async (callback: (t: unknown) => Promise<unknown>) => callback(tx)),
  };
  const financial = { holdClientAtAcceptance: vi.fn(async () => undefined) };
  const pricingCheck = { evaluateManualQuote: vi.fn(async () => null) };
  const service = new CollaborationService(prisma, financial as never, {} as never, pricingCheck as never);
  return { service, prisma, tx, financial, pricingCheck, quotes, events, notifications };
}

const TECH = { id: 't1', role: 'TECHNICIAN' } as never;
const CLIENT = { id: 'c1', role: 'CLIENT' } as never;
const MANUAL_DTO = { amount: 20000, description: 'Réparation robinet' } as never;

describe('createQuote — création manuelle', () => {
  it('technicien assigné, mission ACCEPTED → PENDING, travel figé 2000, anciens PENDING rejetés', async () => {
    const world = quoteService({ quotes: [fullQuote({ id: 'q-old', status: 'PENDING' })] });
    const result = await world.service.createQuote(TECH, 'm1', MANUAL_DTO);
    expect(result.status).toBe('PENDING');
    expect(result.travel).toBe(2000);
    expect(result.totalToDebit).toBe(22000);
    expect(result.source).toBe('MANUAL');
    expect(world.quotes.get('q-old')?.status).toBe('REJECTED');
    expect(world.pricingCheck.evaluateManualQuote).toHaveBeenCalledTimes(1);
    expect(world.events.some((e) => e.type === 'QUOTE_CREATED')).toBe(true);
    expect(world.notifications.some((n) => n.type === 'QUOTE_CREATED' && n.userId === 'c1')).toBe(true);
  });

  it('travelAmount frontend ignoré (2000 forcé)', async () => {
    const world = quoteService();
    const result = await world.service.createQuote(TECH, 'm1', { amount: 15000, travelAmount: 99999, description: 'X' } as never);
    expect(result.travel).toBe(2000);
    expect(result.totalToDebit).toBe(17000);
  });

  it('client → 403 ; étranger → 404 ; mission clôturée → 409', async () => {
    const world = quoteService();
    await expect(world.service.createQuote(CLIENT, 'm1', MANUAL_DTO)).rejects.toMatchObject({ status: 403 });
    await expect(
      world.service.createQuote({ id: 'stranger', role: 'TECHNICIAN' } as never, 'm1', MANUAL_DTO),
    ).rejects.toMatchObject({ status: 404 });
    const closed = quoteService({ demande: { ...DEMANDE, status: 'CONFIRMED' } });
    await expect(closed.service.createQuote(TECH, 'm1', MANUAL_DTO)).rejects.toMatchObject({ status: 409 });
  });

  it('devis existant ACCEPTED → 409, aucune création', async () => {
    const world = quoteService({ quotes: [fullQuote({ id: 'q-a', status: 'ACCEPTED' })] });
    await expect(world.service.createQuote(TECH, 'm1', MANUAL_DTO)).rejects.toMatchObject({ status: 409 });
    expect(world.tx.quote.create).not.toHaveBeenCalled();
  });

  it('IA-6 en panne → création quand même (best-effort, warn tracé)', async () => {
    const world = quoteService();
    world.pricingCheck.evaluateManualQuote.mockRejectedValueOnce(new Error('IA down'));
    const result = await world.service.createQuote(TECH, 'm1', MANUAL_DTO);
    expect(result.status).toBe('PENDING');
  });
});

describe('createQuote — flux catalogue', () => {
  it('sans négociation → 403 ; avec négociation → OK', async () => {
    const locked = quoteService({ catalogFlow: true });
    await expect(locked.service.createQuote(TECH, 'm1', MANUAL_DTO)).rejects.toMatchObject({ status: 403 });
    const unlocked = quoteService({
      catalogFlow: true,
      demande: { ...DEMANDE, negotiationRequestedAt: new Date() },
    });
    const result = await unlocked.service.createQuote(TECH, 'm1', MANUAL_DTO);
    expect(result.status).toBe('PENDING');
  });
});

describe('respondToQuote — acceptation / rejet', () => {
  it('accept → ACCEPTED + hold + finalAmount, event + notif technicien', async () => {
    const world = quoteService({ quotes: [fullQuote({})] });
    const result = await world.service.respondToQuote(CLIENT, 'm1', 'q1', 'accept');
    expect(result.status).toBe('ACCEPTED');
    expect(world.financial.holdClientAtAcceptance).toHaveBeenCalledTimes(1);
    expect(world.tx.demande.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ finalAmount: 22000 }) }),
    );
    expect(world.events.some((e) => e.type === 'QUOTE_ACCEPTED')).toBe(true);
  });

  it('double accept concurrent (claim 0) → 409, hold unique', async () => {
    const world = quoteService({ quotes: [fullQuote({ status: 'ACCEPTED' })], claimCount: 0 });
    await expect(world.service.respondToQuote(CLIENT, 'm1', 'q1', 'accept')).rejects.toMatchObject({ status: 409 });
    expect(world.financial.holdClientAtAcceptance).not.toHaveBeenCalled();
  });

  it('reject → REJECTED sans hold', async () => {
    const world = quoteService({ quotes: [fullQuote({})] });
    const result = await world.service.respondToQuote(CLIENT, 'm1', 'q1', 'reject');
    expect(result.status).toBe('REJECTED');
    expect(world.financial.holdClientAtAcceptance).not.toHaveBeenCalled();
  });

  it('technicien → 403 ; devis inconnu → 404', async () => {
    const world = quoteService({ quotes: [fullQuote({})] });
    await expect(world.service.respondToQuote(TECH, 'm1', 'q1', 'accept')).rejects.toMatchObject({ status: 403 });
    await expect(world.service.respondToQuote(CLIENT, 'm1', 'nope', 'accept')).rejects.toMatchObject({ status: 404 });
  });
});

describe('requestNegotiation — catalogue uniquement', () => {
  it('CATALOG PENDING → horodaté + event + notif', async () => {
    const world = quoteService({ quotes: [fullQuote({ source: 'CATALOG' })] });
    const result = await world.service.requestNegotiation(CLIENT, 'm1', 'q1');
    expect(result.demandeId).toBe('m1');
    expect(typeof result.negotiationRequestedAt).toBe('string');
    expect(world.events.some((e) => e.type === 'NEGOTIATION_REQUESTED')).toBe(true);
  });

  it('MANUAL → 404 ; déjà traité → 409 ; technicien → 403', async () => {
    const world = quoteService({ quotes: [fullQuote({ source: 'MANUAL' })] });
    await expect(world.service.requestNegotiation(CLIENT, 'm1', 'q1')).rejects.toMatchObject({ status: 404 });
    const done = quoteService({ quotes: [fullQuote({ source: 'CATALOG', status: 'ACCEPTED' })] });
    await expect(done.service.requestNegotiation(CLIENT, 'm1', 'q1')).rejects.toMatchObject({ status: 409 });
    await expect(world.service.requestNegotiation(TECH, 'm1', 'q1')).rejects.toMatchObject({ status: 403 });
  });
});
