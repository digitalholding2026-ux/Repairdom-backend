import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDemandeDto } from './dto/create-demande.dto.js';
import { DemandesService } from './demandes.service.js';
import { toApiDemande } from './demande-helpers.js';

/* Parcours « Autre appareil » — indice structuré (code de famille) exigé
 * quand il n'y a pas de domaine catalogue. Prisma simulé, aucun réseau. */

/* `description` est OBLIGATOIRE depuis le micro-fix DTO (10 caractères min).
 * Elle est fournie par défaut ici pour que ces tests continuent de porter
 * sur `equipmentFamily`/`domainId`, et non sur la description. */
function dto(overrides: Record<string, unknown> = {}) {
  return plainToInstance(CreateDemandeDto, {
    categoryId: 'autre',
    description: 'La console ne démarre plus du tout depuis hier soir.',
    city: 'Douala',
    medias: [{ kind: 'IMAGE', name: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 100 }],
    ...overrides,
  });
}

const FAMILIES: Record<string, { code: string; category: string; isActive: boolean }> = {
  GAME_CONSOLE: { code: 'GAME_CONSOLE', category: 'electromenager', isActive: true },
  UNKNOWN: { code: 'UNKNOWN', category: 'autre', isActive: true },
  OFF: { code: 'OFF', category: 'autre', isActive: false },
};

function mockPrisma() {
  const inputs: unknown[] = [];
  const tx = {
    demande: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        inputs.push(data);
        return {
          id: 'd-1',
          reference: 'RD-000001',
          status: 'SUBMITTED',
          createdAt: new Date('2026-01-01T00:00:00.000Z'),
          ...data,
          medias: [],
          technician: null,
          domain: null,
          brand: null,
          model: null,
          problem: null,
        };
      }),
    },
    demandeEvent: { create: vi.fn(async (args: unknown) => args) },
  };
  const prisma = {
    $transaction: vi.fn(async (cb: (t: unknown) => Promise<unknown>) => cb(tx)),
    serviceCity: { findMany: vi.fn(async () => []) },
    zone: { findMany: vi.fn(async () => []) },
    // Catalogue fixé : domaine SANS catégorie métier,
    // marque et modèle cohérents et actifs.
    serviceDomain: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'd-1' ? { id: 'd-1', category: null, isActive: true } : null,
      ),
    },
    deviceBrand: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'b-1' ? { id: 'b-1', domainId: 'd-1', isActive: true } : null,
      ),
    },
    deviceModel: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        where.id === 'm-1' ? { id: 'm-1', brandId: 'b-1', isActive: true } : null,
      ),
    },
    problem: { findUnique: vi.fn(async () => null) },
    equipmentFamily: {
      findUnique: vi.fn(async ({ where }: { where: { code: string } }) => FAMILIES[where.code] ?? null),
    },
  };
  const dispatch = { dispatchWave1: vi.fn(async () => undefined) };
  const service = new DemandesService(
    prisma as never,
    {} as never,
    dispatch as never,
    { isConfirmationBlocked: vi.fn(async () => false) } as never,
  );
  return { service, inputs, dispatch };
}

describe('DTO — equipmentFamily borné (code structuré)', () => {
  it('>40 caractères refusé', async () => {
    expect(await validate(dto({ equipmentFamily: 'X'.repeat(41) }))).not.toEqual([]);
  });

  it('code valide accepté, absent accepté (le service tranche selon Autre)', async () => {
    expect(await validate(dto({ equipmentFamily: 'GAME_CONSOLE' }))).toEqual([]);
    expect(await validate(dto())).toEqual([]);
  });
});

describe('DemandesService.create — indice structuré si Autre sans domaine', () => {
  it('Autre sans indice → 400, rien de persisté', async () => {
    const { service, inputs } = mockPrisma();
    await expect(service.create('c-1', dto() as never)).rejects.toMatchObject({ status: 400 });
    expect(inputs).toHaveLength(0);
  });

  it('Autre + indice inconnu ou inactif → 400', async () => {
    const { service } = mockPrisma();
    await expect(
      service.create('c-1', dto({ equipmentFamily: 'NOPE' }) as never),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.create('c-1', dto({ equipmentFamily: 'OFF' }) as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('Autre + GAME_CONSOLE → catégorie electromenager, code stocké, texte null', async () => {
    const { service, inputs } = mockPrisma();
    const result = await service.create('c-1', dto({ equipmentFamily: 'GAME_CONSOLE' }) as never);
    expect((inputs[0] as Record<string, unknown>).equipmentFamily).toBe('GAME_CONSOLE');
    expect((inputs[0] as Record<string, unknown>).category).toBe('electromenager');
    expect((inputs[0] as Record<string, unknown>).equipmentType).toBeNull();
    expect(result.equipmentFamily).toBe('GAME_CONSOLE');
  });

  it('code en minuscules → normalisé en majuscules', async () => {
    const { service, inputs } = mockPrisma();
    await service.create('c-1', dto({ equipmentFamily: '  game_console ' }) as never);
    expect((inputs[0] as Record<string, unknown>).equipmentFamily).toBe('GAME_CONSOLE');
  });

  it('UNKNOWN (« Je ne sais pas ») → catégorie autre, identifiable', async () => {
    const { service, inputs } = mockPrisma();
    const result = await service.create('c-1', dto({ equipmentFamily: 'UNKNOWN' }) as never);
    expect((inputs[0] as Record<string, unknown>).equipmentFamily).toBe('UNKNOWN');
    expect((inputs[0] as Record<string, unknown>).category).toBe('autre');
    expect(result.categoryId).toBe('autre');
  });

  it('domaine + indice → 400 (incohérent : catalogue OU indice)', async () => {
    const { service } = mockPrisma();
    await expect(
      service.create('c-1', dto({ domainId: 'd-1', brandId: 'b-1', equipmentFamily: 'GAME_CONSOLE' }) as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('domaine sans marque → 400 (plus de dépôt sans marque)', async () => {
    const { service, inputs } = mockPrisma();
    await expect(service.create('c-1', dto({ domainId: 'd-1' }) as never)).rejects.toMatchObject({
      status: 400,
    });
    expect(inputs).toHaveLength(0);
  });

  it('domaine + marque réelle → 201 sans indice ni modèle', async () => {
    const { service, inputs } = mockPrisma();
    const result = await service.create('c-1', dto({ domainId: 'd-1', brandId: 'b-1' }) as never);
    expect((inputs[0] as Record<string, unknown>).brandId).toBe('b-1');
    expect((inputs[0] as Record<string, unknown>).modelId).toBeNull();
    expect(result.equipmentFamily).toBeNull();
  });

  it('domaine normal non-autre sans indice → inchangé', async () => {
    const { service, inputs } = mockPrisma();
    const normal = dto({ categoryId: 'plomberie' });
    const result = await service.create('c-1', normal as never);
    expect((inputs[0] as Record<string, unknown>).equipmentFamily).toBeNull();
    expect(result.equipmentFamily).toBeNull();
  });

  it('dispatch en panne → demande créée quand même (non bloquant)', async () => {
    const { service } = mockPrisma();
    (service as unknown as { dispatch: { dispatchWave1: unknown } }).dispatch = {
      dispatchWave1: vi.fn(async () => Promise.reject(new Error('dispatch down'))),
    };
    const result = await service.create('c-1', dto({ equipmentFamily: 'GAME_CONSOLE' }) as never);
    expect(result.id).toBe('d-1');
  });
});

describe('toApiDemande — indice exposé, texte historique conservé', () => {
  it('renvoie le code famille, null sinon', () => {
    const record = {
      id: 'd-1',
      reference: 'RD-1',
      status: 'SUBMITTED',
      category: 'electromenager',
      description: 'La console ne démarre plus.',
      city: 'Douala',
      cityId: null,
      zoneId: null,
      neighborhood: null,
      address: null,
      landmark: null,
      contactPhone: null,
      latitude: null,
      longitude: null,
      clientId: 'c-1',
      technicianId: null,
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
    };
    expect(toApiDemande({ ...record, equipmentFamily: 'GAME_CONSOLE' }).equipmentFamily).toBe(
      'GAME_CONSOLE',
    );
    expect(toApiDemande(record).equipmentFamily).toBeNull();
    expect(toApiDemande({ ...record, equipmentType: 'Portail électrique' }).equipmentType).toBe(
      'Portail électrique',
    );
  });
});
