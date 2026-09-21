import { describe, expect, it, vi } from 'vitest';
import {
  DISPATCH_CHANNEL_EMAIL,
  DISPATCH_CHANNEL_IN_APP,
  DISPATCH_WAVE_1,
  DISPATCH_WAVE_2,
  DispatchService,
  isDispatchableDemande,
  isWave2Due,
  selectCandidatesForWave,
  type DispatchCandidate,
} from './dispatch.service.js';

/* Sprint DISPATCH-V1 — §19 : sélection, arrêt, idempotence, e-mail non bloquant.
 * Service testé avec Prisma/Config/Email simulés (aucune base de données). */

const CITY_A = 'city-a';
const CITY_B = 'city-b';

function candidate(overrides: Partial<DispatchCandidate> = {}): DispatchCandidate {
  return {
    userId: 'tech-1',
    email: 'tech-1@example.com',
    city: 'Douala',
    cityId: CITY_A,
    categories: ['plomberie'],
    isAvailable: true,
    kycStatus: 'VERIFIED',
    coverageZoneIds: ['z-boko'],
    ...overrides,
  };
}

const DEMANDE = { city: 'Douala', cityId: CITY_A, zoneId: 'z-boko', category: 'plomberie' };

describe('selectCandidatesForWave — vague 1', () => {
  it('disponible + zone correspondante → sélectionné', () => {
    expect(selectCandidatesForWave([candidate()], DEMANDE, DISPATCH_WAVE_1, [])).toHaveLength(1);
  });

  it('isAvailable=false → exclu', () => {
    expect(
      selectCandidatesForWave([candidate({ isAvailable: false })], DEMANDE, DISPATCH_WAVE_1, []),
    ).toHaveLength(0);
  });

  it('KYC non VERIFIED → sélectionné quand même (notification ≠ acceptation)', () => {
    expect(
      selectCandidatesForWave([candidate({ kycStatus: 'PENDING' })], DEMANDE, DISPATCH_WAVE_1, []),
    ).toHaveLength(1);
    expect(
      selectCandidatesForWave(
        [candidate({ kycStatus: 'NOT_SUBMITTED' })],
        DEMANDE,
        DISPATCH_WAVE_2,
        [],
      ),
    ).toHaveLength(1);
  });

  it('KYC non VERIFIED + hors zone → exclu en vague 1 (cas 3)', () => {
    expect(
      selectCandidatesForWave(
        [candidate({ kycStatus: 'PENDING', coverageZoneIds: ['z-akwa'] })],
        DEMANDE,
        DISPATCH_WAVE_1,
        [],
      ),
    ).toHaveLength(0);
  });

  it('KYC non VERIFIED + autre ville → exclu vagues 1 et 2 (cas 4)', () => {
    const other = candidate({ kycStatus: 'PENDING', cityId: CITY_B, city: 'Yaoundé', coverageZoneIds: [] });
    expect(selectCandidatesForWave([other], DEMANDE, DISPATCH_WAVE_1, [])).toHaveLength(0);
    expect(selectCandidatesForWave([other], DEMANDE, DISPATCH_WAVE_2, [])).toHaveLength(0);
  });

  it('KYC VERIFIED mais indisponible → exclu (cas 5, règle inchangée)', () => {
    expect(
      selectCandidatesForWave(
        [candidate({ kycStatus: 'VERIFIED', isAvailable: false })],
        DEMANDE,
        DISPATCH_WAVE_1,
        [],
      ),
    ).toHaveLength(0);
    expect(
      selectCandidatesForWave(
        [candidate({ kycStatus: 'PENDING', isAvailable: false })],
        DEMANDE,
        DISPATCH_WAVE_2,
        [],
      ),
    ).toHaveLength(0);
  });

  it('hors zone → exclu', () => {
    expect(
      selectCandidatesForWave(
        [candidate({ coverageZoneIds: ['z-akwa'] })],
        DEMANDE,
        DISPATCH_WAVE_1,
        [],
      ),
    ).toHaveLength(0);
  });

  it('autre ville → exclu (jamais d’inter-ville)', () => {
    expect(
      selectCandidatesForWave(
        [candidate({ cityId: CITY_B, city: 'Yaoundé', coverageZoneIds: ['z-boko'] })],
        DEMANDE,
        DISPATCH_WAVE_1,
        [],
      ),
    ).toHaveLength(0);
  });

  it('catégorie incompatible → exclu', () => {
    expect(
      selectCandidatesForWave(
        [candidate({ categories: ['electricite'] })],
        DEMANDE,
        DISPATCH_WAVE_1,
        [],
      ),
    ).toHaveLength(0);
  });
});

describe('selectCandidatesForWave — vague 2', () => {
  it('même ville hors zone → sélectionné (zone non exigée)', () => {
    expect(
      selectCandidatesForWave(
        [candidate({ coverageZoneIds: ['z-akwa'] })],
        DEMANDE,
        DISPATCH_WAVE_2,
        [],
      ),
    ).toHaveLength(1);
  });

  it('techniciens de la vague 1 → exclus', () => {
    const techs = [candidate({ userId: 'a' }), candidate({ userId: 'b' }), candidate({ userId: 'c' })];
    expect(selectCandidatesForWave(techs, DEMANDE, DISPATCH_WAVE_2, ['a', 'b', 'c'])).toHaveLength(0);
    expect(
      selectCandidatesForWave(techs, { ...DEMANDE, zoneId: 'z-akwa' }, DISPATCH_WAVE_2, ['a']),
    ).toHaveLength(2);
  });

  it('autre ville → exclue même en vague 2', () => {
    expect(
      selectCandidatesForWave(
        [candidate({ cityId: CITY_B, city: 'Yaoundé', coverageZoneIds: [] })],
        DEMANDE,
        DISPATCH_WAVE_2,
        [],
      ),
    ).toHaveLength(0);
  });
});

describe('gardes d’arrêt', () => {
  it('isDispatchableDemande : attribuée/annulée/terminée → false', () => {
    expect(isDispatchableDemande({ status: 'SUBMITTED', technicianId: null })).toBe(true);
    expect(isDispatchableDemande({ status: 'PENDING', technicianId: null })).toBe(true);
    expect(isDispatchableDemande({ status: 'SUBMITTED', technicianId: 't' })).toBe(false);
    expect(isDispatchableDemande({ status: 'ACCEPTED', technicianId: 't' })).toBe(false);
    expect(isDispatchableDemande({ status: 'CANCELED', technicianId: null })).toBe(false);
    expect(isDispatchableDemande({ status: 'CONFIRMED', technicianId: 't' })).toBe(false);
  });

  it('isWave2Due : 10 minutes depuis sentAt persisté', () => {
    const sentAt = new Date('2026-09-21T10:00:00Z');
    expect(isWave2Due(sentAt, new Date('2026-09-21T10:09:59Z'))).toBe(false);
    expect(isWave2Due(sentAt, new Date('2026-09-21T10:10:00Z'))).toBe(true);
    expect(isWave2Due(sentAt, new Date('2026-09-21T11:00:00Z'))).toBe(true);
  });
});

interface MockCalls {
  waveRows: unknown[];
  notifications: unknown[];
  events: unknown[];
  emails: string[];
}

function mockPrisma(demande: {
  id: string;
  reference: string;
  status: string;
  category: string;
  city: string;
  cityId: string | null;
  zoneId: string | null;
  technicianId: string | null;
} | null, techs: Array<{
  id: string;
  email: string | null;
  technicianProfile: {
    city: string;
    cityId: string | null;
    categories: string[];
    isAvailable: boolean;
    kycStatus: string;
    zoneCoverages: Array<{ zoneId: string; zone: { isActive: boolean; cityId: string } }>;
  } | null;
}>, existingWaves: Array<{ userId: string }> = [], existingWave = false) {
  const calls: MockCalls = { waveRows: [], notifications: [], events: [], emails: [] };
  const tx = {
    dispatchWave: {
      createMany: vi.fn(async (args: { data: unknown[] }) => {
        calls.waveRows.push(...args.data);
        return { count: args.data.length };
      }),
    },
    notification: {
      createMany: vi.fn(async (args: { data: unknown[] }) => {
        calls.notifications.push(...args.data);
        return { count: args.data.length };
      }),
    },
    demandeEvent: {
      create: vi.fn(async (args: unknown) => {
        calls.events.push(args);
        return args;
      }),
    },
  };
  const prisma = {
    demande: { findUnique: vi.fn(async () => demande) },
    dispatchWave: {
      findFirst: vi.fn(async () => (existingWave ? { id: 'w' } : null)),
      findMany: vi.fn(async (args: { select?: { userId?: boolean } }) => {
        if (args.select && 'userId' in args.select) return existingWaves;
        return [];
      }),
      createMany: tx.dispatchWave.createMany,
    },
    user: { findMany: vi.fn(async () => techs) },
    $transaction: vi.fn(async (cb: (txArg: typeof tx) => Promise<unknown>) => cb(tx)),
  };
  return { prisma, calls };
}

function mockService(
  demande: Parameters<typeof mockPrisma>[0],
  techs: Parameters<typeof mockPrisma>[1],
  opts: { existingWaves?: Array<{ userId: string }>; existingWave?: boolean; emailOk?: boolean; emailFails?: boolean } = {},
) {
  const { prisma, calls } = mockPrisma(demande, techs, opts.existingWaves, opts.existingWave);
  const email = {
    isConfigured: opts.emailOk !== false,
    sendMissionAvailable: vi.fn(async (to: string) => {
      if (opts.emailFails) throw new Error('resend_error — test');
      calls.emails.push(to);
    }),
  };
  const config = { get: vi.fn((key: string) => (key === 'FRONTEND_URL' ? 'https://app.test' : undefined)) };
  const service = new DispatchService(
    prisma as never,
    config as never,
    email as never,
  );
  return { service, calls, email };
}

const DEMANDE_ROW = {
  id: 'd-1',
  reference: 'RD-ABCDEF',
  status: 'SUBMITTED',
  category: 'plomberie',
  city: 'Douala',
  cityId: CITY_A,
  zoneId: 'z-boko',
  technicianId: null,
};

const TECH_ROW = {
  id: 'tech-1',
  email: 'tech-1@example.com',
  technicianProfile: {
    city: 'Douala',
    cityId: CITY_A,
    categories: ['plomberie'],
    isAvailable: true,
    kycStatus: 'VERIFIED',
    zoneCoverages: [{ zoneId: 'z-boko', zone: { isActive: true, cityId: CITY_A } }],
  },
};

describe('runWave — arrêt et idempotence', () => {
  it('mission déjà acceptée → aucune vague, aucune écriture', async () => {
    const { service, calls } = mockService({ ...DEMANDE_ROW, technicianId: 't' }, [TECH_ROW]);
    const result = await service.dispatchWave1('d-1');
    expect(result).toEqual({ wave: 1, notified: 0, skipped: true });
    expect(calls.waveRows).toHaveLength(0);
    expect(calls.notifications).toHaveLength(0);
    expect(calls.events).toHaveLength(0);
  });

  it('mission annulée → aucune vague', async () => {
    const { service, calls } = mockService({ ...DEMANDE_ROW, status: 'CANCELED' }, [TECH_ROW]);
    const result = await service.dispatchWave1('d-1');
    expect(result.skipped).toBe(true);
    expect(calls.waveRows).toHaveLength(0);
  });

  it('vague déjà créée (double exécution scheduler) → pas de doublon', async () => {
    const { service, calls } = mockService(DEMANDE_ROW, [TECH_ROW], { existingWave: true });
    const result = await service.dispatchWave1('d-1');
    expect(result.skipped).toBe(true);
    expect(calls.waveRows).toHaveLength(0);
    expect(calls.notifications).toHaveLength(0);
  });

  it('vague 1 nominale : traces + In-App + e-mail', async () => {
    const { service, calls } = mockService(DEMANDE_ROW, [TECH_ROW]);
    const result = await service.dispatchWave1('d-1');
    expect(result).toEqual({ wave: 1, notified: 1, skipped: false });
    expect(calls.waveRows).toHaveLength(2);
    expect(calls.waveRows).toContainEqual(
      expect.objectContaining({ demandeId: 'd-1', wave: 1, userId: 'tech-1', channel: DISPATCH_CHANNEL_IN_APP }),
    );
    expect(calls.waveRows).toContainEqual(
      expect.objectContaining({ demandeId: 'd-1', wave: 1, userId: 'tech-1', channel: DISPATCH_CHANNEL_EMAIL }),
    );
    expect(calls.notifications).toHaveLength(1);
    expect(calls.notifications).toContainEqual(expect.objectContaining({ type: 'MISSION_AVAILABLE' }));
    expect(calls.events).toHaveLength(1);
    expect(calls.emails).toEqual(['tech-1@example.com']);
  });

  it('cas 2 — technicien PENDING notifié (In-App + e-mail), comme un VERIFIED', async () => {
    const pendingTech = {
      ...TECH_ROW,
      technicianProfile: { ...TECH_ROW.technicianProfile, kycStatus: 'PENDING' },
    };
    const { service, calls } = mockService(DEMANDE_ROW, [pendingTech]);
    const result = await service.dispatchWave1('d-1');
    expect(result).toEqual({ wave: 1, notified: 1, skipped: false });
    expect(calls.waveRows).toHaveLength(2);
    expect(calls.waveRows).toContainEqual(
      expect.objectContaining({ demandeId: 'd-1', wave: 1, userId: 'tech-1', channel: DISPATCH_CHANNEL_IN_APP }),
    );
    expect(calls.waveRows).toContainEqual(
      expect.objectContaining({ demandeId: 'd-1', wave: 1, userId: 'tech-1', channel: DISPATCH_CHANNEL_EMAIL }),
    );
    expect(calls.notifications).toHaveLength(1);
    expect(calls.notifications).toContainEqual(expect.objectContaining({ type: 'MISSION_AVAILABLE' }));
    expect(calls.emails).toEqual(['tech-1@example.com']);
  });

  it('e-mail échoué → notification In-App conservée, pas d’exception', async () => {
    const { service, calls } = mockService(DEMANDE_ROW, [TECH_ROW], { emailFails: true });
    const result = await service.dispatchWave1('d-1');
    expect(result).toEqual({ wave: 1, notified: 1, skipped: false });
    expect(calls.notifications).toHaveLength(1);
    expect(calls.emails).toHaveLength(0);
  });

  it('Resend non configuré → In-App seule, sans ligne EMAIL', async () => {
    const { service, calls } = mockService(DEMANDE_ROW, [TECH_ROW], { emailOk: false });
    const result = await service.dispatchWave1('d-1');
    expect(result.notified).toBe(1);
    expect(calls.waveRows).toHaveLength(1);
    expect(calls.notifications).toHaveLength(1);
  });

  it('technicien sans e-mail → In-App seule', async () => {
    const { service, calls } = mockService(DEMANDE_ROW, [{ ...TECH_ROW, email: null }]);
    const result = await service.dispatchWave1('d-1');
    expect(result.notified).toBe(1);
    expect(calls.waveRows).toHaveLength(1);
  });
});
