import { describe, expect, it, vi } from 'vitest';
import { TechnicianService } from './technician.service.js';

/* GPS V1 — PATCH /technician/location (service) : le technicien connecté ne
 * met à jour que SA position (userId JWT) ; `locationUpdatedAt` = heure de
 * CETTE transmission ; profil absent → 404. Prisma simulé, aucun réseau. */

function mockService(existing: Record<string, unknown> | null) {
  const update = vi.fn(async (args: { data: Record<string, unknown> }) => ({
    ...(existing as Record<string, unknown>),
    ...args.data,
    user: { firstName: 'Awa', lastName: 'S', phone: null, email: 't@example.com', role: 'TECHNICIAN' },
  }));
  const prisma = {
    technicianProfile: {
      findUnique: vi.fn(async () => existing),
      update,
    },
    demande: { count: vi.fn(async () => 0) },
  };
  const service = new TechnicianService(prisma as never, {} as never, {} as never);
  return { service, update };
}

const EXISTING = {
  id: 'profile-1',
  userId: 'tech-1',
  city: 'Douala',
  cityId: 'city-a',
  categories: ['plomberie'],
  isAvailable: true,
  avatarUrl: null,
  bio: null,
  experience: null,
  serviceDescription: null,
  specialties: [],
  kycStatus: 'VERIFIED',
  kycRejectionReason: null,
  lastLatitude: null,
  lastLongitude: null,
  locationUpdatedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('updateLocation', () => {
  it('enregistre lat/lng + locationUpdatedAt de CETTE transmission', async () => {
    const { service, update } = mockService(EXISTING);
    const before = Date.now();
    const result = await service.updateLocation('tech-1', 4.0511, 9.7085);
    expect(update).toHaveBeenCalledTimes(1);
    const call = update.mock.calls[0][0] as {
      where: { userId: string };
      data: Record<string, unknown>;
    };
    const data = call.data;
    expect(data.lastLatitude).toBe(4.0511);
    expect(data.lastLongitude).toBe(9.7085);
    expect(data.locationUpdatedAt).toBeInstanceOf(Date);
    expect((data.locationUpdatedAt as Date).getTime()).toBeGreaterThanOrEqual(before);
    expect(result.lastLatitude).toBe(4.0511);
    expect(result.lastLongitude).toBe(9.7085);
    expect(typeof result.locationUpdatedAt).toBe('string');
  });

  it('ne touche que le profil du JWT (where userId)', async () => {
    const { service, update } = mockService(EXISTING);
    await service.updateLocation('tech-1', 4, 9);
    const call = update.mock.calls[0][0] as {
      where: { userId: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ userId: 'tech-1' });
    // Aucun autre champ métier modifié.
    expect(Object.keys(call.data).sort()).toEqual(
      ['lastLatitude', 'lastLongitude', 'locationUpdatedAt'].sort(),
    );
  });

  it('profil absent → 404, aucune écriture', async () => {
    const { service, update } = mockService(null);
    await expect(service.updateLocation('unknown', 4, 9)).rejects.toThrow(
      'Profil technicien introuvable.',
    );
    expect(update).not.toHaveBeenCalled();
  });
});
