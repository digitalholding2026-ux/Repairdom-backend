import { describe, expect, it, vi } from 'vitest';
import { TechnicianService } from './technician.service.js';
import { DemandeMediaService } from '../demandes/demande-media.service.js';

/* Médias client AVANT acceptation : détail d'opportunité éligible (métadonnées)
 * + lecture signée sur mission ouverte non assignée. Listes toujours sans
 * médias ; assigned/propriétaire inchangés ; tiers → 404. */

function demandeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd-1',
    reference: 'RD-ABC123',
    status: 'SUBMITTED',
    category: 'plomberie',
    description: null,
    city: 'Douala',
    cityId: 'city-1',
    zoneId: null,
    zoneRef: null,
    cityRef: null,
    neighborhood: null,
    address: '12 rue X',
    landmark: null,
    contactPhone: '+237600000000',
    latitude: null,
    longitude: null,
    clientId: 'c-1',
    technicianId: null,
    scheduledAt: null,
    requestedMode: 'ASAP',
    requestedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    domainId: null,
    brandId: null,
    modelId: null,
    problemId: null,
    negotiationRequestedAt: null,
    finalAmount: null,
    travelLatitude: null,
    travelLongitude: null,
    travelLocationUpdatedAt: null,
    technicianEnRouteAt: null,
    technicianArrivedAt: null,
    domain: null,
    brand: null,
    model: null,
    problem: null,
    medias: [
      {
        id: 'm-1',
        kind: 'AUDIO',
        fileName: 'vocal.webm',
        mimeType: 'audio/webm',
        sizeBytes: 1200,
        stored: true,
        storagePath: 'demandes/c-1/v.webm',
      },
    ],
    ...overrides,
  };
}

function profileRow() {
  return {
    id: 'tp-2',
    userId: 't-2',
    cityId: 'city-1',
    city: 'Douala',
    categories: ['plomberie'],
  };
}

function technicianService(demande: Record<string, unknown>) {
  const prisma = {
    technicianProfile: { findUnique: vi.fn(async () => profileRow()) },
    technicianZoneCoverage: { findMany: vi.fn(async () => []) },
    demande: { findUnique: vi.fn(async () => demande) },
  };
  return new TechnicianService(prisma as never, {} as never, {} as never);
}

describe('getDemandeDetail éligible — médias visibles avant acceptation', () => {
  it('opportunité éligible : medias présents, adresse/téléphone toujours masqués', async () => {
    const result = await technicianService(demandeRow()).getDemandeDetail('t-2', 'd-1');
    expect(result.medias).toHaveLength(1);
    expect(result.medias[0]).toMatchObject({ id: 'm-1', kind: 'AUDIO', stored: true });
    expect(result.medias[0]).not.toHaveProperty('storagePath');
    expect(result.address).toBeNull();
    expect(result.contactPhone).toBeNull();
  });

  it('mission déjà assignée à un autre → 404 (sans fuite)', async () => {
    const svc = technicianService(demandeRow({ technicianId: 't-9', status: 'ACCEPTED' }));
    await expect(svc.getDemandeDetail('t-2', 'd-1')).rejects.toMatchObject({ status: 404 });
  });
});

describe('getMediaFileUrl — mission ouverte non assignée', () => {
  function mediaSvc(demande: Record<string, unknown>, media: Record<string, unknown> | null) {
    const prisma = {
      demande: { findUnique: vi.fn(async () => demande) },
      demandeMedia: { findFirst: vi.fn(async () => media) },
    };
    const storage = {
      createDemandeSignedUrl: vi.fn(async (path: string) => `https://signed/${path}`),
    };
    return new DemandeMediaService(prisma as never, storage as never);
  }

  const openDemande = { id: 'd-1', status: 'SUBMITTED', clientId: 'c-1', technicianId: null };
  const media = { id: 'm-1', demandeId: 'd-1', storagePath: 'demandes/c-1/v.webm' };

  it('technicien non assigné sur mission ouverte → URL signée', async () => {
    const url = await mediaSvc(openDemande, media).getMediaFileUrl(
      { userId: 't-2', role: 'TECHNICIAN' },
      'd-1',
      'm-1',
    );
    expect(url).toContain('demandes/c-1/v.webm');
  });

  it('mission déjà assignée à un autre → 404', async () => {
    const svc = mediaSvc({ ...openDemande, technicianId: 't-9', status: 'ACCEPTED' }, media);
    await expect(
      svc.getMediaFileUrl({ userId: 't-2', role: 'TECHNICIAN' }, 'd-1', 'm-1'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('mission clôturée non assignée → 404', async () => {
    const svc = mediaSvc({ ...openDemande, status: 'CONFIRMED' }, media);
    await expect(
      svc.getMediaFileUrl({ userId: 't-2', role: 'TECHNICIAN' }, 'd-1', 'm-1'),
    ).rejects.toMatchObject({ status: 404 });
  });
});
