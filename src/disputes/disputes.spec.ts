import { describe, expect, it, vi } from 'vitest';
import { DemandesService } from '../demandes/demandes.service.js';
import { FinancialService } from '../financial/financial.service.js';
import { DisputesService } from './disputes.service.js';
import { DemandesController } from '../demandes/demandes.controller.js';
import { CollaborationController } from '../collaboration/collaboration.controller.js';
import { AdminController } from '../admin/admin.controller.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ConfigService } from '@nestjs/config';

/* Parcours litige post-intervention (Prisma simulé en mémoire) :
 *   COMPLETED → OPEN (client) → UNDER_REVIEW → RESOLVED|REJECTED (admin).
 * CONFIRMED bloqué sauf REJECTED ; RESOLVED libère le hold sans écriture
 * ledger ; un seul litige par mission (unicité demandeId). */

type Row = Record<string, any>;
const MODE = 'SIMULATION';

function fullDemande(overrides: Row): Row {
  return {
    id: 'm1',
    reference: 'RD-ABC123',
    status: 'COMPLETED',
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
    ...overrides,
  };
}

function mockWorld(seed: { demandes?: Row[]; disputes?: Row[]; holds?: Row[] } = {}) {
  const users: Record<string, Row> = {
    c1: { id: 'c1', role: 'CLIENT', isActive: true },
    t1: { id: 't1', role: 'TECHNICIAN', isActive: true },
    a1: { id: 'a1', role: 'ADMIN', isActive: true },
    stranger: { id: 'stranger', role: 'CLIENT', isActive: true },
  };
  const demandes = new Map<string, Row>(seed.demandes?.map((d) => [d.id, { ...d }]) ?? []);
  const disputeRows = new Map<string, Row>(seed.disputes?.map((d) => [d.id, { ...d }]) ?? []);
  const holds = new Map<string, Row>((seed.holds ?? []).map((h) => [h.reference, { ...h }]));
  const events: Row[] = [];
  const notifications: Row[] = [];
  const ledger: Row[] = [];
  let seq = 0;

  const tx: any = {
    $executeRaw: vi.fn(async () => []),
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
            return { ...d, medias: [], technician: null };
          }
        }
        return null;
      }),
      findFirstOrThrow: vi.fn(async ({ where }: any = {}) => {
        for (const d of demandes.values()) {
          if (
            (where.id === undefined || d.id === where.id) &&
            (where.clientId === undefined || d.clientId === where.clientId)
          ) {
            return { ...d, medias: [], technician: null };
          }
        }
        throw new Error('not found');
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const d of demandes.values()) {
          if (
            (where.id === undefined || d.id === where.id) &&
            (where.clientId === undefined || d.clientId === where.clientId) &&
            (where.status === undefined || d.status === where.status)
          ) {
            Object.assign(d, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    demandeDispute: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return disputeRows.get(where.id) ? { ...disputeRows.get(where.id) } : null;
        if (where.demandeId) {
          for (const d of disputeRows.values()) {
            if (d.demandeId === where.demandeId) return { ...d };
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        for (const d of disputeRows.values()) {
          if (d.demandeId === data.demandeId) {
            throw Object.assign(new Error('Unique constraint'), { code: 'P2002' });
          }
        }
        const row = {
          id: `dispute-${(seq += 1)}`,
          status: 'OPEN',
          resolution: null,
          decidedById: null,
          decidedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
        disputeRows.set(row.id, row);
        return { ...row, demande: { id: row.demandeId, reference: 'RD-ABC123', status: 'COMPLETED' } };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = disputeRows.get(where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return { ...row, demande: { id: row.demandeId, reference: 'RD-ABC123', status: 'COMPLETED' } };
      }),
      findMany: vi.fn(async ({ where, orderBy, skip, take }: any = {}) => {
        let rows = [...disputeRows.values()];
        if (where?.status) rows = rows.filter((r) => r.status === where.status);
        rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        void orderBy;
        return rows.slice(skip ?? 0, (skip ?? 0) + (take ?? 20)).map((r) => ({ ...r }));
      }),
      count: vi.fn(async ({ where }: any = {}) => {
        let rows = [...disputeRows.values()];
        if (where?.status) rows = rows.filter((r) => r.status === where.status);
        return rows.length;
      }),
    },
    fundsHold: {
      findUnique: vi.fn(async ({ where }: any) => holds.get(where.reference) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const h of holds.values()) {
          if (
            (where.reference === undefined || h.reference === where.reference) &&
            (where.status === undefined || h.status === where.status)
          ) {
            Object.assign(h, data);
            count += 1;
          }
        }
        return { count };
      }),
    },
    quote: { findFirst: vi.fn(async () => null) },
    user: {
      findUnique: vi.fn(async ({ where }: any) => users[where.id] ?? null),
      findMany: vi.fn(async ({ where }: any = {}) =>
        Object.values(users).filter(
          (u) =>
            (where.role === undefined || u.role === where.role) &&
            (where.isActive === undefined || u.isActive === where.isActive),
        ),
      ),
    },
    demandeEvent: { create: vi.fn(async ({ data }: any) => { events.push(data); return data; }) },
    notification: { create: vi.fn(async ({ data }: any) => { notifications.push(data); return data; }) },
    financialTransaction: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => { ledger.push(data); return data; }),
    },
  };
  const prisma = {
    ...tx,
    // Rollback transactionnel simulé (comme mission-holds.spec.ts) : un
    // 409 APRÈS le claim annule l'écriture, comme en base réelle.
    $transaction: vi.fn(async (callback: (t: unknown) => Promise<unknown>) => {
      const snapDemandes = new Map([...demandes].map(([k, v]) => [k, { ...v }]));
      const snapDisputes = new Map([...disputeRows].map(([k, v]) => [k, { ...v }]));
      const snapHolds = new Map([...holds].map(([k, v]) => [k, { ...v }]));
      const snapLedger = ledger.length;
      const snapEvents = events.length;
      const snapNotifications = notifications.length;
      try {
        return await callback(tx);
      } catch (error) {
        demandes.clear();
        for (const [k, v] of snapDemandes) demandes.set(k, v);
        disputeRows.clear();
        for (const [k, v] of snapDisputes) disputeRows.set(k, v);
        holds.clear();
        for (const [k, v] of snapHolds) holds.set(k, v);
        ledger.length = snapLedger;
        events.length = snapEvents;
        notifications.length = snapNotifications;
        throw error;
      }
    }),
    $executeRaw: vi.fn(async () => []),
  };
  const config = { get: vi.fn(() => MODE) } as unknown as ConfigService;
  const financial = new FinancialService(prisma as unknown as PrismaService, config);
  const disputes = new DisputesService(prisma as unknown as PrismaService, financial);
  const demandesService = new DemandesService(
    prisma as unknown as PrismaService,
    financial,
    {} as never,
    { classifyAutreDemande: vi.fn(async () => ({ classification: 'UNCLASSIFIABLE' })) } as never,
    disputes,
  );
  return { prisma, tx, financial, disputes, demandesService, store: { demandes, disputes: disputeRows, holds, events, notifications, ledger } };
}

const OPEN_DTO = { category: 'QUALITY', description: 'Le robinet fuit toujours après intervention.' } as never;
const CLIENT = { id: 'c1', role: 'CLIENT' } as never;
const TECH = { id: 't1', role: 'TECHNICIAN' } as never;

describe('ouverture — droits et gardes', () => {
  it('COMPLETED + technicien → OPEN, event + notifs tech/admin', async () => {
    const { disputes, store } = mockWorld({ demandes: [fullDemande({})] });
    const result = await disputes.openDispute('c1', 'm1', OPEN_DTO);
    expect(result.status).toBe('OPEN');
    expect(result.category).toBe('QUALITY');
    expect(store.events.some((e) => e.type === 'DISPUTE_OPENED')).toBe(true);
    expect(store.notifications.some((n) => n.type === 'DISPUTE_OPENED' && n.userId === 't1')).toBe(true);
    expect(store.notifications.some((n) => n.type === 'DISPUTE_OPENED' && n.userId === 'a1')).toBe(true);
  });

  it('non-propriétaire → 404 masqué', async () => {
    const { disputes } = mockWorld({ demandes: [fullDemande({})] });
    await expect(disputes.openDispute('stranger', 'm1', OPEN_DTO)).rejects.toMatchObject({ status: 404 });
  });

  it('mission non terminée (IN_PROGRESS) → 409', async () => {
    const { disputes } = mockWorld({ demandes: [fullDemande({ status: 'IN_PROGRESS' })] });
    await expect(disputes.openDispute('c1', 'm1', OPEN_DTO)).rejects.toMatchObject({ status: 409 });
  });

  it('sans technicien assigné → 409', async () => {
    const { disputes } = mockWorld({ demandes: [fullDemande({ technicianId: null })] });
    await expect(disputes.openDispute('c1', 'm1', OPEN_DTO)).rejects.toMatchObject({ status: 409 });
  });

  it('double ouverture → 409 (unicité demandeId)', async () => {
    const { disputes } = mockWorld({
      demandes: [fullDemande({})],
      disputes: [{ id: 'd-old', demandeId: 'm1', status: 'OPEN', createdAt: new Date() }],
    });
    await expect(disputes.openDispute('c1', 'm1', OPEN_DTO)).rejects.toMatchObject({ status: 409 });
  });

  it('motif invalide / description trop courte → 400', async () => {
    const { disputes } = mockWorld({ demandes: [fullDemande({})] });
    await expect(
      disputes.openDispute('c1', 'm1', { category: 'NOPE', description: 'assez long quand même' } as never),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      disputes.openDispute('c1', 'm1', { category: 'QUALITY', description: 'court' } as never),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('lecture parties — ownership', () => {
  it('client propriétaire et technicien assigné lisent ; étranger → 404', async () => {
    const { disputes } = mockWorld({
      demandes: [fullDemande({})],
      disputes: [{ id: 'd-1', demandeId: 'm1', status: 'OPEN', createdAt: new Date(), updatedAt: new Date() }],
    });
    expect(await disputes.getForParty(CLIENT, 'm1')).toMatchObject({ id: 'd-1' });
    expect(await disputes.getForParty(TECH, 'm1')).toMatchObject({ id: 'd-1' });
    await expect(
      disputes.getForParty({ id: 'stranger', role: 'CLIENT' } as never, 'm1'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('sans litige → null (état UI, pas 404)', async () => {
    const { disputes } = mockWorld({ demandes: [fullDemande({})] });
    expect(await disputes.getForParty(CLIENT, 'm1')).toBeNull();
  });
});

describe('revue admin — transitions', () => {
  function worldWithOpen() {
    return mockWorld({
      demandes: [fullDemande({})],
      disputes: [{ id: 'd-1', demandeId: 'm1', status: 'OPEN', createdAt: new Date(), updatedAt: new Date() }],
    });
  }

  it('OPEN → UNDER_REVIEW (sans décision)', async () => {
    const { disputes } = worldWithOpen();
    const result = await disputes.reviewDispute('a1', 'd-1', { decision: 'UNDER_REVIEW' } as never);
    expect(result.status).toBe('UNDER_REVIEW');
    expect(result.decidedAt).toBeNull();
  });

  it('UNDER_REVIEW → RESOLVED libère le hold ACTIVE, sans écriture ledger', async () => {
    const world = mockWorld({
      demandes: [fullDemande({})],
      disputes: [{ id: 'd-1', demandeId: 'm1', status: 'UNDER_REVIEW', createdAt: new Date(), updatedAt: new Date() }],
      holds: [{ reference: 'mission-hold:m1:SIMULATION', demandeId: 'm1', userId: 'c1', amount: 22000, mode: MODE, status: 'ACTIVE' }],
    });
    const result = await world.disputes.reviewDispute('a1', 'd-1', {
      decision: 'RESOLVED',
      resolution: 'Travaux non conformes constatés, fonds restitués au client.',
    } as never);
    expect(result.status).toBe('RESOLVED');
    expect(world.store.holds.get('mission-hold:m1:SIMULATION')?.status).toBe('RELEASED');
    expect(world.store.ledger).toHaveLength(0);
    expect(world.store.events.some((e) => e.type === 'DISPUTE_RESOLVED')).toBe(true);
    expect(world.store.notifications.some((n) => n.type === 'DISPUTE_RESOLVED' && n.userId === 'c1')).toBe(true);
  });

  it('UNDER_REVIEW → REJECTED (décision motivée requise)', async () => {
    const { disputes } = mockWorld({
      demandes: [fullDemande({})],
      disputes: [{ id: 'd-1', demandeId: 'm1', status: 'UNDER_REVIEW', createdAt: new Date(), updatedAt: new Date() }],
    });
    await expect(
      disputes.reviewDispute('a1', 'd-1', { decision: 'REJECTED' } as never),
    ).rejects.toMatchObject({ status: 400 });
    const result = await disputes.reviewDispute('a1', 'd-1', {
      decision: 'REJECTED',
      resolution: 'Photos et rapport conformes, intervention validée.',
    } as never);
    expect(result.status).toBe('REJECTED');
  });

  it('litige tranché → 409, jamais de régression', async () => {
    const { disputes } = mockWorld({
      demandes: [fullDemande({})],
      disputes: [{ id: 'd-1', demandeId: 'm1', status: 'RESOLVED', createdAt: new Date(), updatedAt: new Date() }],
    });
    await expect(
      disputes.reviewDispute('a1', 'd-1', { decision: 'REJECTED', resolution: 'Trop tard, c’est tranché.' } as never),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('litige inexistant → 404 ; décision invalide → 400', async () => {
    const { disputes } = mockWorld({ demandes: [fullDemande({})] });
    await expect(disputes.reviewDispute('a1', 'nope', { decision: 'REJECTED', resolution: 'x'.repeat(20) } as never)).rejects.toMatchObject({ status: 404 });
    const world2 = worldWithOpen();
    await expect(world2.disputes.reviewDispute('a1', 'd-1', { decision: 'NOPE' } as never)).rejects.toMatchObject({ status: 400 });
  });
});

describe('blocage du règlement — CONFIRMED vs litige', () => {
  it('OPEN → CONFIRMED refusé (409), aucun règlement', async () => {
    const world = mockWorld({
      demandes: [fullDemande({})],
      disputes: [{ id: 'd-1', demandeId: 'm1', status: 'OPEN', createdAt: new Date(), updatedAt: new Date() }],
      holds: [{ reference: 'mission-hold:m1:SIMULATION', demandeId: 'm1', userId: 'c1', amount: 22000, mode: MODE, status: 'ACTIVE' }],
    });
    await expect(
      world.demandesService.updateStatus('c1', 'm1', { status: 'CONFIRMED' } as never),
    ).rejects.toMatchObject({ status: 409 });
    expect(world.store.demandes.get('m1')?.status).toBe('COMPLETED');
    expect(world.store.holds.get('mission-hold:m1:SIMULATION')?.status).toBe('ACTIVE');
    expect(world.store.ledger).toHaveLength(0);
  });

  it('REJECTED → CONFIRMED autorisé (règlement normal)', async () => {
    const world = mockWorld({
      demandes: [fullDemande({})],
      disputes: [{ id: 'd-1', demandeId: 'm1', status: 'REJECTED', createdAt: new Date(), updatedAt: new Date() }],
    });
    const result = await world.demandesService.updateStatus('c1', 'm1', { status: 'CONFIRMED' } as never);
    expect(result.status).toBe('CONFIRMED');
  });

  it('RESOLVED → CONFIRMED toujours bloqué (hold libéré, pas de débit sans hold)', async () => {
    const world = mockWorld({
      demandes: [fullDemande({})],
      disputes: [{ id: 'd-1', demandeId: 'm1', status: 'RESOLVED', createdAt: new Date(), updatedAt: new Date() }],
      holds: [{ reference: 'mission-hold:m1:SIMULATION', demandeId: 'm1', userId: 'c1', amount: 22000, mode: MODE, status: 'RELEASED' }],
    });
    await expect(
      world.demandesService.updateStatus('c1', 'm1', { status: 'CONFIRMED' } as never),
    ).rejects.toMatchObject({ status: 409 });
    expect(world.store.ledger).toHaveLength(0);
  });
});

describe('routes — guards et rôles', () => {
  it('client : POST/GET :id/dispute exposés sous contrôleur CLIENT', () => {
    const roles = Reflect.getMetadata('roles', DemandesController) as string[] | undefined;
    expect(roles).toEqual(['CLIENT']);
    const proto = DemandesController.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.openDispute).toBe('function');
    expect(typeof proto.getDispute).toBe('function');
  });

  it('technicien : GET :demandeId/dispute exposé sous contrôleur CLIENT,TECHNICIAN', () => {
    const roles = Reflect.getMetadata('roles', CollaborationController) as string[] | undefined;
    expect(roles).toEqual(expect.arrayContaining(['CLIENT', 'TECHNICIAN']));
    const proto = CollaborationController.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.getDispute).toBe('function');
  });

  it('admin : disputes exposés sous contrôleur ADMIN', () => {
    const roles = Reflect.getMetadata('roles', AdminController) as string[] | undefined;
    expect(roles).toEqual(['ADMIN']);
    const proto = AdminController.prototype as unknown as Record<string, unknown>;
    expect(typeof proto.listDisputes).toBe('function');
    expect(typeof proto.getDispute).toBe('function');
    expect(typeof proto.reviewDispute).toBe('function');
  });
});

describe('consultation admin', () => {
  it('liste paginée + filtre statut ; statut invalide → 400', async () => {
    const { disputes } = mockWorld({
      demandes: [fullDemande({})],
      disputes: [
        { id: 'd-1', demandeId: 'm1', status: 'OPEN', createdAt: new Date('2026-01-02'), updatedAt: new Date('2026-01-02') },
        { id: 'd-2', demandeId: 'm2', status: 'RESOLVED', createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') },
      ],
    });
    const all = await disputes.listForAdmin({});
    expect(all.total).toBe(2);
    expect(all.items[0].id).toBe('d-1');
    const open = await disputes.listForAdmin({ status: 'OPEN' });
    expect(open.total).toBe(1);
    await expect(disputes.listForAdmin({ status: 'NOPE' })).rejects.toMatchObject({ status: 400 });
  });

  it('détail + 404', async () => {
    const { disputes } = mockWorld({
      demandes: [fullDemande({})],
      disputes: [{ id: 'd-1', demandeId: 'm1', status: 'OPEN', createdAt: new Date(), updatedAt: new Date() }],
    });
    expect(await disputes.getForAdmin('d-1')).toMatchObject({ id: 'd-1' });
    await expect(disputes.getForAdmin('nope')).rejects.toMatchObject({ status: 404 });
  });
});
