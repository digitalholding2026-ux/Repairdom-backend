import { describe, expect, it, vi } from 'vitest';
import { TechnicianService } from './technician.service.js';
import { toApiTravelClient, toApiTravelMapClient, toApiTravelTechnician } from '../demandes/demandes.service.js';
import { GPS_TRAVEL_FRESHNESS_MS, isLocationFresh } from '../geo/geo-distance.js';

/* GPS V3 — déplacement temporaire lié à la mission (service) :
 * « Je suis en route » / actualisation / « Je suis arrivé ».
 * Autorisations (assigné uniquement), validation des coordonnées,
 * fraîcheur, journal métier et vue client SANS coordonnées brutes.
 * Prisma simulé en mémoire, aucun réseau. */

interface FakeDemande {
  id: string;
  reference: string;
  status: string;
  category: string;
  description: string;
  city: string;
  cityId: string | null;
  zoneId: string | null;
  zoneRef: null;
  cityRef: null;
  neighborhood: string | null;
  address: string | null;
  landmark: string | null;
  contactPhone: string | null;
  latitude: number | null;
  longitude: number | null;
  clientId: string;
  technicianId: string | null;
  scheduledAt: Date | null;
  requestedMode: string;
  requestedAt: Date | null;
  domainId: string | null;
  brandId: string | null;
  modelId: string | null;
  problemId: string | null;
  negotiationRequestedAt: Date | null;
  finalAmount: number | null;
  medias: never[];
  createdAt: Date;
  travelLatitude: number | null;
  travelLongitude: number | null;
  travelLocationUpdatedAt: Date | null;
  technicianEnRouteAt: Date | null;
  technicianArrivedAt: Date | null;
}

function demandeRow(overrides: Partial<FakeDemande> = {}): FakeDemande {
  return {
    id: 'd1',
    reference: 'RD-ABC123',
    status: 'SCHEDULED',
    category: 'plomberie',
    description: 'Fuite',
    city: 'Douala',
    cityId: null,
    zoneId: null,
    zoneRef: null,
    cityRef: null,
    neighborhood: null,
    address: null,
    landmark: null,
    contactPhone: null,
    latitude: 4.0511,
    longitude: 9.7085,
    clientId: 'client-1',
    technicianId: 'tech-1',
    scheduledAt: null,
    requestedMode: 'ASAP',
    requestedAt: null,
    domainId: null,
    brandId: null,
    modelId: null,
    problemId: null,
    negotiationRequestedAt: null,
    finalAmount: null,
    medias: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    travelLatitude: null,
    travelLongitude: null,
    travelLocationUpdatedAt: null,
    technicianEnRouteAt: null,
    technicianArrivedAt: null,
    ...overrides,
  };
}

function mockService(rows: FakeDemande[]) {
  const events: Array<{ type: string }> = [];
  const notifications: Array<{ userId: string; type: string }> = [];
  const byId = new Map(rows.map((r) => [r.id, r]));

  function matches(row: FakeDemande, where: Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(where)) {
      if (key === 'status' && value && typeof value === 'object') {
        const statusIn = (value as { in?: string[] }).in;
        if (statusIn && !statusIn.includes(row.status)) return false;
        continue;
      }
      const current = (row as unknown as Record<string, unknown>)[key];
      if (value === null) {
        if (current !== null) return false;
        continue;
      }
      if (current !== value) return false;
    }
    return true;
  }

  const tx = {
    demande: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        [...byId.values()].find((r) => matches(r, where)) ?? null,
      ),
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        byId.get(where.id) ?? null,
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          const row = [...byId.values()].find((r) => matches(r, where));
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        },
      ),
      findFirstOrThrow: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const row = [...byId.values()].find((r) => matches(r, where));
        if (!row) throw new Error('No record found');
        return row;
      }),
    },
    demandeEvent: {
      create: vi.fn(async ({ data }: { data: { type: string } }) => {
        events.push({ type: data.type });
        return data;
      }),
    },
    notification: {
      create: vi.fn(async ({ data }: { data: { userId: string; type: string } }) => {
        notifications.push({ userId: data.userId, type: data.type });
        return data;
      }),
    },
  };
  const prisma = { $transaction: async (cb: (t: unknown) => unknown) => cb(tx) };
  const service = new TechnicianService(prisma as never, {} as never, {} as never);
  return { service, tx, events, notifications };
}

describe('startTravel', () => {
  it('technicien assigné + mission planifiée → déplacement démarré + journal + notification client', async () => {
    const { service, events, notifications } = mockService([demandeRow()]);
    const result = await service.startTravel('tech-1', 'd1', 4.05, 9.7);
    expect(result.travel.enRoute).toBe(true);
    expect(result.travel.arrived).toBe(false);
    expect(result.travel.latitude).toBe(4.05);
    expect(result.travel.longitude).toBe(9.7);
    expect(result.travel.enRouteAt).not.toBeNull();
    expect(events).toEqual([{ type: 'TECHNICIAN_EN_ROUTE' }]);
    // Notification unique au client de LA mission.
    expect(notifications).toEqual([{ userId: 'client-1', type: 'TECHNICIAN_EN_ROUTE' }]);
  });

  it('technicien non assigné → refus (403), aucune écriture', async () => {
    const { service, tx } = mockService([demandeRow()]);
    await expect(service.startTravel('tech-2', 'd1', 4.05, 9.7)).rejects.toMatchObject({
      status: 403,
    });
    expect(tx.demande.updateMany).not.toHaveBeenCalled();
  });

  it('mission inexistante → 404', async () => {
    const { service } = mockService([demandeRow()]);
    await expect(service.startTravel('tech-1', 'unknown', 4.05, 9.7)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('identifiant client (jamais assigné) → refus, jamais 200', async () => {
    const { service } = mockService([demandeRow()]);
    await expect(service.startTravel('client-1', 'd1', 4.05, 9.7)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('coordonnées invalides → 400, aucune écriture', async () => {
    const { service, tx, events } = mockService([demandeRow()]);
    await expect(service.startTravel('tech-1', 'd1', 200, 9.7)).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.startTravel('tech-1', 'd1', NaN, 9.7)).rejects.toMatchObject({
      status: 400,
    });
    expect(tx.demande.updateMany).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('mission ACCEPTED (non planifiée) → refus propre, lifecycle préservé', async () => {
    const { service } = mockService([demandeRow({ status: 'ACCEPTED' })]);
    await expect(service.startTravel('tech-1', 'd1', 4.05, 9.7)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('mission terminée (COMPLETED) → refus 409, ledger non touché', async () => {
    const { service, tx } = mockService([demandeRow({ status: 'COMPLETED' })]);
    await expect(service.startTravel('tech-1', 'd1', 4.05, 9.7)).rejects.toMatchObject({
      status: 409,
    });
    expect(tx.demande.updateMany).not.toHaveBeenCalled();
  });

  it('déplacement déjà arrivé → redémarrage refusé (409)', async () => {
    const { service } = mockService([
      demandeRow({
        technicianEnRouteAt: new Date('2026-02-01T10:00:00.000Z'),
        technicianArrivedAt: new Date('2026-02-01T10:30:00.000Z'),
      }),
    ]);
    await expect(service.startTravel('tech-1', 'd1', 4.05, 9.7)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('réémission avant arrivée = actualisation (enRouteAt conservé, 1 seule notification)', async () => {
    const started = new Date('2026-02-01T10:00:00.000Z');
    const { service, events, notifications } = mockService([
      demandeRow({ technicianEnRouteAt: started, travelLatitude: 4.0, travelLongitude: 9.7 }),
    ]);
    const result = await service.startTravel('tech-1', 'd1', 4.06, 9.71);
    expect(result.travel.enRouteAt).toBe(started.toISOString());
    expect(result.travel.latitude).toBe(4.06);
    expect(events).toEqual([{ type: 'TECHNICIAN_EN_ROUTE' }]);
    expect(notifications).toHaveLength(0);
  });
});

describe('refreshTravelLocation', () => {
  it('déplacement actif → position remplacée (aucun historique)', async () => {
    const started = new Date(Date.now() - 5 * 60 * 1000);
    const { service } = mockService([
      demandeRow({
        technicianEnRouteAt: started,
        travelLatitude: 4.0,
        travelLongitude: 9.7,
        travelLocationUpdatedAt: started,
      }),
    ]);
    const result = await service.refreshTravelLocation('tech-1', 'd1', 4.08, 9.72);
    expect(result.travel.latitude).toBe(4.08);
    expect(result.travel.enRouteAt).toBe(started.toISOString());
    expect(result.travel.fresh).toBe(true);
  });

  it('sans déplacement démarré → 400', async () => {
    const { service } = mockService([demandeRow()]);
    await expect(service.refreshTravelLocation('tech-1', 'd1', 4.08, 9.72)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('après arrivée → 400, position figée', async () => {
    const { service, tx } = mockService([
      demandeRow({
        technicianEnRouteAt: new Date('2026-02-01T10:00:00.000Z'),
        technicianArrivedAt: new Date('2026-02-01T10:30:00.000Z'),
      }),
    ]);
    await expect(service.refreshTravelLocation('tech-1', 'd1', 4.08, 9.72)).rejects.toMatchObject({
      status: 400,
    });
    expect(tx.demande.updateMany).not.toHaveBeenCalled();
  });
});

describe('markArrived', () => {
  it('déplacement actif → arrivée enregistrée + journal, déplacement clos', async () => {
    const { service, events } = mockService([
      demandeRow({ technicianEnRouteAt: new Date('2026-02-01T10:00:00.000Z') }),
    ]);
    const result = await service.markArrived('tech-1', 'd1', 4.0512, 9.7086);
    expect(result.travel.arrived).toBe(true);
    expect(result.travel.enRoute).toBe(false);
    expect(result.travel.arrivedAt).not.toBeNull();
    expect(result.travel.latitude).toBe(4.0512);
    expect(events).toEqual([{ type: 'TECHNICIAN_ARRIVED' }]);
  });

  it('sans GPS (autorisation indisponible) → arrivée quand même enregistrée, position inchangée', async () => {
    const { service } = mockService([
      demandeRow({
        technicianEnRouteAt: new Date('2026-02-01T10:00:00.000Z'),
        travelLatitude: 4.0,
        travelLongitude: 9.7,
      }),
    ]);
    const result = await service.markArrived('tech-1', 'd1');
    expect(result.travel.arrived).toBe(true);
    expect(result.travel.latitude).toBe(4.0);
  });

  it('arrivée avant « en route » → 400', async () => {
    const { service } = mockService([demandeRow()]);
    await expect(service.markArrived('tech-1', 'd1', 4.05, 9.7)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('double arrivée → 409', async () => {
    const { service } = mockService([
      demandeRow({
        technicianEnRouteAt: new Date('2026-02-01T10:00:00.000Z'),
        technicianArrivedAt: new Date('2026-02-01T10:30:00.000Z'),
      }),
    ]);
    await expect(service.markArrived('tech-1', 'd1')).rejects.toMatchObject({ status: 409 });
  });
});

describe('vues travel (fraîcheur + confidentialité)', () => {
  const base = {
    latitude: 4.0511,
    longitude: 9.7085,
    travelLatitude: 4.06,
    travelLongitude: 9.71,
    technicianEnRouteAt: new Date('2026-02-01T10:00:00.000Z'),
    technicianArrivedAt: null,
  };

  it('position fraîche (< 15 min) → fresh + distance calculée (Haversine)', () => {
    const now = new Date('2026-02-01T10:10:00.000Z');
    const view = toApiTravelClient(
      { ...base, travelLocationUpdatedAt: new Date('2026-02-01T10:05:00.000Z') },
      now,
    );
    expect(view.enRoute).toBe(true);
    expect(view.fresh).toBe(true);
    expect(view.minutesSinceUpdate).toBe(5);
    expect(typeof view.distanceMeters).toBe('number');
    expect(view.distanceMeters).toBeGreaterThan(0);
  });

  it('position périmée (> 15 min) → non fraîche, AUCUNE distance (jamais inventée)', () => {
    const now = new Date('2026-02-01T11:00:00.000Z');
    const view = toApiTravelClient(
      { ...base, travelLocationUpdatedAt: new Date('2026-02-01T10:00:00.000Z') },
      now,
    );
    expect(view.fresh).toBe(false);
    expect(view.distanceMeters).toBeNull();
    expect(view.minutesSinceUpdate).toBe(60);
  });

  it('fenêtre V3 = 15 minutes (principe V2 réutilisé, seuil adapté)', () => {
    expect(GPS_TRAVEL_FRESHNESS_MS).toBe(15 * 60 * 1000);
    const now = new Date('2026-02-01T10:00:00.000Z');
    expect(isLocationFresh(new Date('2026-02-01T09:50:00.000Z'), now, GPS_TRAVEL_FRESHNESS_MS)).toBe(true);
    expect(isLocationFresh(new Date('2026-02-01T09:44:00.000Z'), now, GPS_TRAVEL_FRESHNESS_MS)).toBe(false);
  });

  it('vue client : AUCUNE coordonnée brute exposée', () => {
    const view = toApiTravelClient({
      ...base,
      travelLocationUpdatedAt: new Date('2026-02-01T10:05:00.000Z'),
    });
    expect(view).not.toHaveProperty('latitude');
    expect(view).not.toHaveProperty('longitude');
    expect(view).not.toHaveProperty('travelLatitude');
    expect(view).not.toHaveProperty('travelLongitude');
    expect(JSON.stringify(view)).not.toContain('4.06');
  });

  it('sans position → vue propre (localisation indisponible côté UI)', () => {
    const view = toApiTravelClient({
      latitude: 4.0511,
      longitude: 9.7085,
      travelLatitude: null,
      travelLongitude: null,
      travelLocationUpdatedAt: null,
      technicianEnRouteAt: new Date('2026-02-01T10:00:00.000Z'),
      technicianArrivedAt: null,
    });
    expect(view.enRoute).toBe(true);
    expect(view.fresh).toBe(false);
    expect(view.distanceMeters).toBeNull();
    expect(view.minutesSinceUpdate).toBeNull();
  });

  it('position demande absente → distance null (jamais 0 forcé)', () => {
    const view = toApiTravelTechnician({
      ...base,
      latitude: null,
      longitude: null,
      travelLocationUpdatedAt: new Date(),
    });
    expect(view.distanceMeters).toBeNull();
  });
});

describe('travelMap V4 (rendu carte client)', () => {
  const base = {
    latitude: 4.0511,
    longitude: 9.7085,
    travelLatitude: 4.06,
    travelLongitude: 9.71,
    technicianEnRouteAt: new Date('2026-02-01T10:00:00.000Z'),
    technicianArrivedAt: null,
  };
  const freshAt = new Date('2026-02-01T10:05:00.000Z');
  const now = new Date('2026-02-01T10:10:00.000Z');

  it('déplacement actif + position fraîche → point technicien exposé', () => {
    const view = toApiTravelMapClient({ ...base, travelLocationUpdatedAt: freshAt }, now);
    expect(view).toEqual({ technician: { latitude: 4.06, longitude: 9.71 } });
  });

  it('position périmée → point null (jamais présentée comme actuelle)', () => {
    const view = toApiTravelMapClient(
      { ...base, travelLocationUpdatedAt: new Date('2026-02-01T09:00:00.000Z') },
      now,
    );
    expect(view).toEqual({ technician: null });
  });

  it('pas encore en route → point null', () => {
    const view = toApiTravelMapClient(
      { ...base, technicianEnRouteAt: null, travelLocationUpdatedAt: freshAt },
      now,
    );
    expect(view).toEqual({ technician: null });
  });

  it('technicien arrivé (déplacement clos) → point null', () => {
    const view = toApiTravelMapClient(
      {
        ...base,
        technicianArrivedAt: new Date('2026-02-01T10:30:00.000Z'),
        travelLocationUpdatedAt: freshAt,
      },
      now,
    );
    expect(view).toEqual({ technician: null });
  });

  it('coordonnées de déplacement absentes → point null', () => {
    const view = toApiTravelMapClient(
      { ...base, travelLatitude: null, travelLongitude: null, travelLocationUpdatedAt: freshAt },
      now,
    );
    expect(view).toEqual({ technician: null });
  });
});
