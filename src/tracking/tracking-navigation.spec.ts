import { describe, expect, it, vi } from 'vitest';
import { TrackingService } from './tracking.service.js';
import {
  TRACKING_REFERENCE_PATTERN,
  isValidTrackingReference,
} from './tracking-reference.js';
import {
  TRACKING_THROTTLE_LIMIT,
  TRACKING_THROTTLE_WINDOW_MS,
  TrackingThrottleGuard,
} from './tracking-throttle.guard.js';

/* CHANTIER NAVIGATION P1/P2 — suivi public : format strict, throttle
 * anti-balayage, aucune donnée privée. Prisma simulé, aucun réseau. */

function guardContext(ip: string) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ ip, headers: {}, socket: {} }),
    }),
  } as never;
}

describe('format RD-XXXXXX', () => {
  it('valide : 6 symboles de l’alphabet (sans I ni O)', () => {
    expect(isValidTrackingReference('RD-8F4K29')).toBe(true);
    expect(isValidTrackingReference('rd-8f4k29')).toBe(true);
    expect(isValidTrackingReference('  RD-ABCDEF  ')).toBe(true);
    expect(TRACKING_REFERENCE_PATTERN.test('RD-8F4K29')).toBe(true);
  });

  it('invalide : mauvais format, I/O interdits, casse applicative', () => {
    for (const raw of [
      '',
      'RD-ABC12',
      'RD-ABC1234',
      'RD-ABC12!',
      'XX-ABCDEF',
      'RD-ABCDIF',
      'RD-ABCDOF',
      'RD-abcdef'.replace('a', 'i'),
      null,
      undefined,
      123,
    ]) {
      expect(isValidTrackingReference(raw)).toBe(false);
    }
  });
});

describe('throttle anti-balayage (30/min/IP, 429, anonyme préservé)', () => {
  it(`30 requêtes OK, 31e → 429`, () => {
    expect(TRACKING_THROTTLE_LIMIT).toBe(30);
    expect(TRACKING_THROTTLE_WINDOW_MS).toBe(60_000);
    const guard = new TrackingThrottleGuard();
    const ctx = guardContext('1.2.3.4');
    for (let i = 0; i < 30; i += 1) expect(guard.canActivate(ctx)).toBe(true);
    expect(() => guard.canActivate(ctx)).toThrowError(
      expect.objectContaining({ status: 429 }),
    );
  });

  it('autre IP non affectée (isolement par appelant)', () => {
    const guard = new TrackingThrottleGuard();
    for (let i = 0; i < 30; i += 1) guard.canActivate(guardContext('9.9.9.9'));
    expect(guard.canActivate(guardContext('8.8.8.8'))).toBe(true);
  });
});

describe('données publiques : rien de privé', () => {
  it('ni téléphone, adresse, GPS, finance, conversation, KYC', async () => {
    const prisma = {
      demande: {
        findUnique: vi.fn(async () => ({
          reference: 'RD-8F4K29',
          status: 'IN_PROGRESS',
          category: 'plomberie',
          requestedMode: 'ASAP',
          requestedAt: null,
          scheduledAt: null,
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          contactPhone: '+237690000000',
          address: '123 rue secrète',
          latitude: 4.05,
          longitude: 9.7,
          finalAmount: 99999,
          domain: null,
          brand: null,
          model: null,
          problem: null,
          technician: {
            id: 'tech-1',
            firstName: 'Awa',
            lastName: 'S',
            phone: '+237677000000',
            technicianProfile: { kycStatus: 'VERIFIED' },
          },
          events: [],
        })),
      },
    };
    const service = new TrackingService(prisma as never);
    const result = await service.trackByReference('RD-8F4K29');
    const raw = JSON.stringify(result);
    for (const secret of [
      '+237690000000',
      '+237677000000',
      'rue secrète',
      '99999',
      '4.05',
      '9.7',
    ]) {
      expect(raw).not.toContain(secret);
    }
    expect(result).not.toHaveProperty('contactPhone');
    expect(result).not.toHaveProperty('latitude');
    expect(result).not.toHaveProperty('technician');
    expect(result.technicianAssigned).toBe(true);
    expect(result.technicianVerified).toBe(true);
  });

  it('référence inexistante → 404', async () => {
    const prisma = { demande: { findUnique: vi.fn(async () => null) } };
    const service = new TrackingService(prisma as never);
    await expect(service.trackByReference('RD-ZZ9Z9Z')).rejects.toMatchObject({
      status: 404,
    });
  });
});
