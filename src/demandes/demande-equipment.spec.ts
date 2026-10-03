import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDemandeDto } from './dto/create-demande.dto.js';
import { DemandesService } from './demandes.service.js';
import { toApiDemande } from './demande-helpers.js';

/* Équipement déclaré obligatoire si « Autre » (champ métier conservé).
 * Prisma simulé, aucun réseau. */

function dto(overrides: Record<string, unknown> = {}) {
  return plainToInstance(CreateDemandeDto, {
    categoryId: 'autre',
    city: 'Douala',
    medias: [{ kind: 'IMAGE', name: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 100 }],
    ...overrides,
  });
}

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
    // Catalogue fixé : domaine SANS catégorie métier (cas du bug prod),
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

describe('DTO — equipmentType borné, optionnel au niveau champ', () => {
  it('cas 7 : >120 caractères refusé', async () => {
    expect(await validate(dto({ equipmentType: 'x'.repeat(121) }))).not.toEqual([]);
  });

  it('120 caractères accepté, absent accepté (le service tranche selon Autre)', async () => {
    expect(await validate(dto({ equipmentType: 'x'.repeat(120) }))).toEqual([]);
    expect(await validate(dto())).toEqual([]);
  });
});

describe('DemandesService.create — obligation si Autre (catégorie résolue)', () => {
  it('cas 3 : Autre sans équipement → 400, rien de persisté', async () => {
    const { service, inputs } = mockPrisma();
    await expect(service.create('c-1', dto() as never)).rejects.toMatchObject({ status: 400 });
    expect(inputs).toHaveLength(0);
  });

  it('cas 3 : Autre + équipement vide/espaces → 400', async () => {
    const { service } = mockPrisma();
    await expect(service.create('c-1', dto({ equipmentType: '   ' }) as never)).rejects.toMatchObject({
      status: 400,
    });
  });

  it('cas 1/2 : Autre + équipement → stocké trimmé', async () => {
    const { service, inputs } = mockPrisma();
    const result = await service.create('c-1', dto({ equipmentType: '  réfrigérateur  ' }) as never);
    expect((inputs[0] as Record<string, unknown>).equipmentType).toBe('réfrigérateur');
    expect(result.equipmentType).toBe('réfrigérateur');
  });

  it('cas 4 : domaine normal sans équipement → inchangé, stocké null', async () => {
    const { service, inputs } = mockPrisma();
    const normal = dto({ categoryId: 'plomberie' });
    const result = await service.create('c-1', normal as never);
    expect((inputs[0] as Record<string, unknown>).equipmentType).toBeNull();
    expect(result.equipmentType).toBeNull();
  });

  it('cas 5 (bug prod) : modèle catalogue + catégorie autre, sans équipement → 201', async () => {
    // Parcours Appareil → Marque → Modèle sur un domaine SANS catégorie
    // métier : le modelId valide identifie déjà l'appareil, l'équipement
    // n'est pas exigé même si la catégorie résolue vaut 'autre'.
    const { service, inputs } = mockPrisma();
    const anchored = dto({ domainId: 'd-1', brandId: 'b-1', modelId: 'm-1' });
    const result = await service.create('c-1', anchored as never);
    expect((inputs[0] as Record<string, unknown>).modelId).toBe('m-1');
    expect((inputs[0] as Record<string, unknown>).category).toBe('autre');
    expect(result.equipmentType).toBeNull();
  });

  it('dispatch en panne → demande créée quand même (non bloquant)', async () => {
    const { service } = mockPrisma();
    (service as unknown as { dispatch: { dispatchWave1: unknown } }).dispatch = {
      dispatchWave1: vi.fn(async () => Promise.reject(new Error('dispatch down'))),
    };
    const result = await service.create('c-1', dto({ equipmentType: 'climatiseur' }) as never);
    expect(result.id).toBe('d-1');
  });
});

describe('toApiDemande — équipement exposé tel quel (jamais un diagnostic)', () => {
  it('renvoie la valeur client, null en historique', () => {
    const record = {
      id: 'd-1',
      reference: 'RD-1',
      status: 'SUBMITTED',
      category: 'autre',
      description: null,
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
    expect(toApiDemande({ ...record, equipmentType: 'Portail électrique' }).equipmentType).toBe(
      'Portail électrique',
    );
    expect(toApiDemande(record).equipmentType).toBeNull();
  });
});
