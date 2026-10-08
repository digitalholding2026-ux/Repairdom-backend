import { describe, expect, it, vi } from 'vitest';
import { CollaborationService } from './collaboration.service.js';

/* Correctif post-audit — couverture Quotes/collaboration (aucune spec
 * dédiée auparavant) : création MANUAL/CATALOG, bornes, acceptation,
 * double acceptation, négociation, QuoteSource.
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
      /* `listQuotes` filtre réellement par mission et trie par date : le double
       * applique le `where` (et pas seulement sa forme) pour que le test
       * « le client ne voit pas la commission » exerce la vraie logique. */
      findMany: vi.fn(async ({ where }: any = {}) =>
        [...quotes.values()]
          .filter((q) => where.demandeId === undefined || q.demandeId === where.demandeId)
          .map((q) => ({ ...q }))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      ),
    },
    demandeEvent: tx.demandeEvent,
    notification: tx.notification,
    $transaction: vi.fn(async (callback: (t: unknown) => Promise<unknown>) => callback(tx)),
  };
  const financial = { holdClientAtAcceptance: vi.fn(async () => undefined) };
  const service = new CollaborationService(prisma, financial as never);
  return { service, prisma, tx, financial, quotes, events, notifications };
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

describe('createQuote — seuil minimum 5 000 (chantier 4-FONDATIONS-A)', () => {
  it('4 000 → 400 avec le message métier, AUCUNE écriture', async () => {
    const world = quoteService();
    await expect(
      world.service.createQuote(TECH, 'm1', { amount: 4000, description: 'Petite réparation' } as never),
    ).rejects.toMatchObject({
      status: 400,
      message: "Le montant minimum d'une intervention est de 5 000 FCFA.",
    });
    expect(world.tx.quote.create).not.toHaveBeenCalled();
  });

  it('3 000 → 400 (scénario de test production)', async () => {
    const world = quoteService();
    await expect(
      world.service.createQuote(TECH, 'm1', { amount: 3000, description: 'Intervention' } as never),
    ).rejects.toMatchObject({ status: 400 });
    expect(world.tx.quote.create).not.toHaveBeenCalled();
  });

  it('4 999 → 400, 5 000 → accepté (la borne est inclusive)', async () => {
    const below = quoteService();
    await expect(
      below.service.createQuote(TECH, 'm1', { amount: 4999, description: 'Intervention' } as never),
    ).rejects.toMatchObject({ status: 400 });

    const ok = quoteService();
    const created = await ok.service.createQuote(TECH, 'm1', { amount: 5000, description: 'Intervention' } as never);
    expect(created.status).toBe('PENDING');
    expect(created.amount).toBe(5000);
  });

  it('le seuil ne bloque QUE la création : un devis existant < 5 000 reste acceptable', async () => {
    // Mission en cours au moment du déploiement : le devis de 3 000 a été
    // créé avant. Il doit pouvoir être accepté puis confirmé (scénario Test 4).
    const legacy = quoteService({ quotes: [fullQuote({ amount: 3000, status: 'PENDING' })] });
    const accepted = await legacy.service.respondToQuote(CLIENT, 'm1', 'q1', 'accept');
    expect(accepted.status).toBe('ACCEPTED');
    expect(legacy.financial.holdClientAtAcceptance).toHaveBeenCalledTimes(1);
  });

  it('transparence : commission et net exposés au technicien, jamais au client', async () => {
    const world = quoteService();
    const forTech = await world.service.createQuote(TECH, 'm1', {
      amount: 25000,
      description: 'Remplacement écran',
    } as never);
    // 500 + 4 % de 25 000 = 1 500 ; net = 25 000 + 2 000 − 1 500 = 25 500.
    expect(forTech.commission).toBe(1500);
    expect(forTech.netTechnician).toBe(25500);
    expect(forTech.totalToDebit).toBe(27000);

    const forClient = await world.service.listQuotes(CLIENT, 'm1');
    expect(forClient[0]).not.toHaveProperty('commission');
    expect(forClient[0]).not.toHaveProperty('netTechnician');
  });
});

describe('selectCatalogDiagnostic — le devis auto ne contourne pas le seuil', () => {
  /* Le devis automatique est créé dans `selectCatalogDiagnostic`, chemin
   * distinct de `createQuote` : sans garde dédié, une intervention de
   * catalogue sous 5 000 produirait un devis hors barème. AUCUN `Pricing`
   * n'est modifié — c'est une règle applicative qui renvoie vers le
   * diagnostic libre. */
  function catalogPrisma(referencePrice: number | null) {
    const quotes: Array<Record<string, unknown>> = [];
    const tx = {
      quote: {
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async () => ({ count: 0 })),
        create: vi.fn(async ({ data }: any) => {
          quotes.push(data);
          return { id: 'q-auto', createdAt: new Date(), ...data };
        }),
      },
      diagnostic: {
        create: vi.fn(async ({ data }: any) => ({
          id: 'dg-auto',
          createdAt: new Date(),
          technician: { id: 't1', firstName: 'A', lastName: null },
          ...data,
        })),
      },
      demandeEvent: { create: vi.fn(async (args: unknown) => args) },
      notification: { create: vi.fn(async (args: unknown) => args) },
    };
    const prisma: any = {
      demande: {
        findUnique: vi.fn(async () => ({
          ...DEMANDE,
          domainId: null,
          brandId: null,
          modelId: null,
        })),
      },
      technicianProfile: { findUnique: vi.fn(async () => ({ kycStatus: 'VERIFIED' })) },
      catalogDiagnostic: {
        findUnique: vi.fn(async () => ({
          id: 'cd-1',
          name: 'Diagnostic démarrage',
          isActive: true,
          problem: { domainId: null, brandId: null, modelId: null },
          interventions: [{ id: 'ci-1', name: 'Reset forcé', isActive: true }],
        })),
      },
      pricing: {
        findUnique: vi.fn(async () => ({
          interventionId: 'ci-1',
          isActive: true,
          referencePrice,
          travelFee: 2_000,
          serviceFee: 3_000,
          currency: 'XAF',
        })),
      },
      $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    };
    return { prisma, quotes, tx };
  }

  const CATALOG_DTO = {
    mode: 'CATALOG',
    catalogDiagnosticId: 'cd-1',
    catalogInterventionId: 'ci-1',
  } as never;

  it('prix de référence < 5 000 → 400 renvoyant vers le diagnostic libre', async () => {
    const world = catalogPrisma(3_000);
    await expect(
      new CollaborationService(world.prisma, {} as never).selectCatalogDiagnostic(
        TECH,
        'm1',
        CATALOG_DTO,
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      new CollaborationService(world.prisma, {} as never).selectCatalogDiagnostic(
        TECH,
        'm1',
        CATALOG_DTO,
      ),
    ).rejects.toThrow(/diagnostic libre/i);
    expect(world.tx.quote.create).not.toHaveBeenCalled();
  });

  it('prix de référence = 5 000 → devis automatique accepté', async () => {
    const world = catalogPrisma(5_000);
    const result = await new CollaborationService(world.prisma, {} as never).selectCatalogDiagnostic(
      TECH,
      'm1',
      CATALOG_DTO,
    );
    expect(result.mode).toBe('CATALOG');
    expect(result.quote.amount).toBe(5000);
    expect(result.quote.commission).toBe(700);
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
