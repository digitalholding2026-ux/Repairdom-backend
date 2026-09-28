import { describe, expect, it, vi } from 'vitest';
import { TechnicianService } from './technician.service.js';
import {
  GPS_TRAVEL_FRESHNESS_MS,
  GPS_TRAVEL_MAX_ACCURACY_M,
  GPS_TRAVEL_REFRESH_THROTTLE_MS,
  isLocationFresh,
  isUsableTravelAccuracy,
} from '../geo/geo-distance.js';

/* CHANTIER GPS P0/P1 — « En route » sans GPS, accuracy, throttle, fraîcheur.
 * Prisma simulé en mémoire, aucun réseau, aucune opération financière. */

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
    reference: 'RD-GPS001',
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

describe('en route sans GPS (P0)', () => {
  it('corps vide → en route, sans position, fresh=false, journal + notification', async () => {
    const { service, events, notifications } = mockService([demandeRow()]);
    const result = await service.startTravel('tech-1', 'd1');
    expect(result.travel.enRoute).toBe(true);
    expect(result.travel.arrived).toBe(false);
    expect(result.travel.latitude).toBeNull();
    expect(result.travel.longitude).toBeNull();
    expect(result.travel.fresh).toBe(false);
    expect(result.travel.enRouteAt).not.toBeNull();
    expect(events).toEqual([{ type: 'TECHNICIAN_EN_ROUTE' }]);
    expect(notifications).toEqual([{ userId: 'client-1', type: 'TECHNICIAN_EN_ROUTE' }]);
  });

  it('coordonnées partielle (une seule) → 400', async () => {
    const { service, tx } = mockService([demandeRow()]);
    await expect(service.startTravel('tech-1', 'd1', 4.05, undefined)).rejects.toMatchObject({
      status: 400,
    });
    expect(tx.demande.updateMany).not.toHaveBeenCalled();
  });

  it('coordonnées invalides → 400, aucune écriture', async () => {
    const { service, tx } = mockService([demandeRow()]);
    await expect(service.startTravel('tech-1', 'd1', 200, 9.7)).rejects.toMatchObject({
      status: 400,
    });
    expect(tx.demande.updateMany).not.toHaveBeenCalled();
  });

  it('avec GPS → en route + coordonnées fraîches (régression)', async () => {
    const { service } = mockService([demandeRow()]);
    const result = await service.startTravel('tech-1', 'd1', 4.05, 9.7);
    expect(result.travel.enRoute).toBe(true);
    expect(result.travel.latitude).toBe(4.05);
    expect(result.travel.fresh).toBe(true);
  });
});

describe('accuracy', () => {
  it('seuil documenté : 500 m', () => {
    expect(GPS_TRAVEL_MAX_ACCURACY_M).toBe(500);
    expect(isUsableTravelAccuracy(25)).toBe(true);
    expect(isUsableTravelAccuracy(500)).toBe(true);
    expect(isUsableTravelAccuracy(501)).toBe(false);
    expect(isUsableTravelAccuracy(2000)).toBe(false);
    expect(isUsableTravelAccuracy(null)).toBe(true);
    expect(isUsableTravelAccuracy(undefined)).toBe(true);
  });

  it('fix trop imprécis → en route SANS position (jamais de précision artificielle)', async () => {
    const { service } = mockService([demandeRow()]);
    const result = await service.startTravel('tech-1', 'd1', 4.05, 9.7, 2000);
    expect(result.travel.enRoute).toBe(true);
    expect(result.travel.latitude).toBeNull();
    expect(result.travel.fresh).toBe(false);
  });

  it('refresh trop imprécis → 400, aucune écriture', async () => {
    const started = new Date(Date.now() - 5 * 60 * 1000);
    const { service, tx } = mockService([
      demandeRow({
        technicianEnRouteAt: started,
        travelLatitude: 4.0,
        travelLongitude: 9.7,
        travelLocationUpdatedAt: started,
      }),
    ]);
    await expect(service.refreshTravelLocation('tech-1', 'd1', 4.08, 9.72, 5000)).rejects.toMatchObject({
      status: 400,
    });
    expect(tx.demande.updateMany).not.toHaveBeenCalled();
  });

  it('arrivé avec fix imprécis → arrivée enregistrée sans position', async () => {
    const started = new Date(Date.now() - 5 * 60 * 1000);
    const { service } = mockService([demandeRow({ technicianEnRouteAt: started })]);
    const result = await service.markArrived('tech-1', 'd1', 4.08, 9.72, 9000);
    expect(result.travel.arrived).toBe(true);
    expect(result.travel.latitude).toBeNull();
  });

  it('arrivé sans GPS → fonctionnement préservé', async () => {
    const started = new Date(Date.now() - 5 * 60 * 1000);
    const { service } = mockService([demandeRow({ technicianEnRouteAt: started })]);
    const result = await service.markArrived('tech-1', 'd1');
    expect(result.travel.arrived).toBe(true);
  });
});

describe('throttle refresh', () => {
  it('deux appels rapprochés → une seule écriture (pas de spam DB)', async () => {
    const now = new Date();
    const { service, tx } = mockService([
      demandeRow({
        technicianEnRouteAt: new Date(now.getTime() - 5 * 60 * 1000),
        travelLatitude: 4.0,
        travelLongitude: 9.7,
        travelLocationUpdatedAt: new Date(now.getTime() - 60_000),
      }),
    ]);
    await service.refreshTravelLocation('tech-1', 'd1', 4.08, 9.72);
    expect(tx.demande.updateMany).toHaveBeenCalledTimes(1);
    // Second appel immédiat : throttlé (état renvoyé sans écrire).
    await service.refreshTravelLocation('tech-1', 'd1', 4.09, 9.73);
    expect(tx.demande.updateMany).toHaveBeenCalledTimes(1);
  });

  it('appel après délai → écriture autorisée', async () => {
    const old = new Date(Date.now() - GPS_TRAVEL_REFRESH_THROTTLE_MS - 1000);
    const { service, tx } = mockService([
      demandeRow({
        technicianEnRouteAt: new Date(old.getTime() - 5 * 60 * 1000),
        travelLatitude: 4.0,
        travelLongitude: 9.7,
        travelLocationUpdatedAt: old,
      }),
    ]);
    const result = await service.refreshTravelLocation('tech-1', 'd1', 4.08, 9.72);
    expect(tx.demande.updateMany).toHaveBeenCalledTimes(1);
    expect(result.travel.latitude).toBe(4.08);
  });
});

describe('fraîcheur V3 (15 min, serveur)', () => {
  it('fenêtre : 15 minutes', () => {
    expect(GPS_TRAVEL_FRESHNESS_MS).toBe(15 * 60 * 1000);
    const now = new Date('2026-02-01T10:00:00.000Z');
    expect(isLocationFresh(new Date('2026-02-01T09:50:00.000Z'), now, GPS_TRAVEL_FRESHNESS_MS)).toBe(true);
    expect(isLocationFresh(new Date('2026-02-01T09:44:00.000Z'), now, GPS_TRAVEL_FRESHNESS_MS)).toBe(false);
    expect(isLocationFresh(null, now, GPS_TRAVEL_FRESHNESS_MS)).toBe(false);
  });

  it('position > 15 min → travel.fresh=false, distance=null', async () => {
    const { toApiTravelTechnician } = await import('../demandes/demandes.service.js');
    const old = new Date(Date.now() - 20 * 60 * 1000);
    const view = toApiTravelTechnician({
      latitude: 4.0511,
      longitude: 9.7085,
      travelLatitude: 4.06,
      travelLongitude: 9.71,
      travelLocationUpdatedAt: old,
      technicianEnRouteAt: new Date(old.getTime() - 5 * 60 * 1000),
      technicianArrivedAt: null,
    });
    expect(view.enRoute).toBe(true);
    expect(view.fresh).toBe(false);
    expect(view.distanceMeters).toBeNull();
  });
});
