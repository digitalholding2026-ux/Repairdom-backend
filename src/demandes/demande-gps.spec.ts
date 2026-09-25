import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateDemandeDto } from './dto/create-demande.dto.js';
import { toApiDemande, toApiDemandePublic } from './demande-helpers.js';

/* GPS V1 — demande : coordonnées optionnelles strictes, exposition
 * propriétaire vs publique. Aucune régression sur la création existante. */

function validDto(overrides: Record<string, unknown> = {}) {
  return plainToInstance(CreateDemandeDto, {
    categoryId: 'plomberie',
    description: 'Le robinet de la cuisine fuit en continu.',
    city: 'Douala',
    ...overrides,
  });
}

async function violations(input: CreateDemandeDto) {
  return validate(input);
}

function demandeRow(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return {
    id: 'd-1',
    reference: 'RD-ABC123',
    status: 'SUBMITTED',
    category: 'plomberie',
    description: 'Fuite.',
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
    createdAt: now,
    domainId: null,
    brandId: null,
    modelId: null,
    problemId: null,
    negotiationRequestedAt: null,
    finalAmount: null,
    medias: [],
    ...overrides,
  };
}

describe('CreateDemandeDto — GPS optionnel strict', () => {
  it('sans GPS : valide (aucune régression)', async () => {
    expect(await violations(validDto())).toEqual([]);
  });

  it('GPS valide accepté', async () => {
    expect(await violations(validDto({ latitude: 4.0511, longitude: 9.7085 }))).toEqual([]);
    expect(await violations(validDto({ latitude: -90, longitude: -180 }))).toEqual([]);
    expect(await violations(validDto({ latitude: 90, longitude: 180 }))).toEqual([]);
  });

  it('latitude hors limites refusée', async () => {
    expect((await violations(validDto({ latitude: 90.1, longitude: 9 })))).not.toEqual([]);
    expect((await violations(validDto({ latitude: -91, longitude: 9 })))).not.toEqual([]);
  });

  it('longitude hors limites refusée', async () => {
    expect((await violations(validDto({ latitude: 4, longitude: 180.5 })))).not.toEqual([]);
  });

  it('NaN / chaîne refusés', async () => {
    expect((await violations(validDto({ latitude: Number.NaN, longitude: 9 })))).not.toEqual([]);
    expect((await violations(validDto({ latitude: '4.05', longitude: 9 })))).not.toEqual([]);
  });
});

describe('sérialiseurs — exposition GPS', () => {
  it('toApiDemande expose latitude/longitude (contexte propriétaire)', () => {
    const api = toApiDemande(demandeRow({ latitude: 4.05, longitude: 9.7 }) as never);
    expect(api.latitude).toBe(4.05);
    expect(api.longitude).toBe(9.7);
  });

  it('toApiDemande sans GPS → null (pas undefined)', () => {
    const api = toApiDemande(demandeRow() as never);
    expect(api.latitude).toBeNull();
    expect(api.longitude).toBeNull();
  });

  it('toApiDemandePublic neutralise le GPS comme l’adresse (opportunités)', () => {
    const api = toApiDemandePublic(
      demandeRow({ latitude: 4.05, longitude: 9.7, address: '12 rue X' }) as never,
    );
    expect(api.latitude).toBeNull();
    expect(api.longitude).toBeNull();
    expect(api.address).toBeNull();
  });
});
