import { describe, expect, it, vi } from 'vitest';
import { TechnicianService } from './technician.service.js';

/* Correctif DISPATCH-NOTIFY — cas 6 : un technicien notifié sans KYC VERIFIED
 * ne peut PAS accepter. La garde `acceptDemande` (403 pré-transaction) est
 * testée ici avec Prisma simulé : aucun `updateMany` ne doit partir, aucune
 * assignation n’a lieu. La logique métier d’acceptation est inchangée. */

function mockService(kycStatus: string) {
  const updateMany = vi.fn(async () => ({ count: 0 }));
  const prisma = {
    technicianProfile: {
      findUnique: vi.fn(async () => ({
        id: 'profile-1',
        userId: 'tech-1',
        city: 'Douala',
        cityId: 'city-a',
        categories: ['plomberie'],
        kycStatus,
      })),
    },
    demande: { updateMany, findUnique: vi.fn(async () => null) },
  };
  const service = new TechnicianService(prisma as never, {} as never, {} as never);
  return { service, updateMany };
}

describe('acceptDemande — garde KYC (cas 6)', () => {
  it('KYC PENDING → 403, aucune écriture atomique', async () => {
    const { service, updateMany } = mockService('PENDING');
    await expect(service.acceptDemande('tech-1', 'd-1')).rejects.toThrow(
      'Votre compte technicien doit être vérifié avant de pouvoir accepter une mission.',
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('KYC NOT_SUBMITTED → 403, aucune écriture atomique', async () => {
    const { service, updateMany } = mockService('NOT_SUBMITTED');
    await expect(service.acceptDemande('tech-1', 'd-1')).rejects.toThrow(
      'Votre compte technicien doit être vérifié',
    );
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('KYC REJECTED → 403, aucune écriture atomique', async () => {
    const { service, updateMany } = mockService('REJECTED');
    await expect(service.acceptDemande('tech-1', 'd-1')).rejects.toThrow(
      'Votre compte technicien doit être vérifié',
    );
    expect(updateMany).not.toHaveBeenCalled();
  });
});

/* Correctif post-audit — disponibilité et compte relus DANS la transaction :
 * un technicien devenu indisponible/inactif entre l'affichage et l'acceptation
 * est refusé en 403 avec rollback, sans contourner les gardes existantes. */

function mockServiceInTx(options: {
  kycStatus?: string;
  isAvailable?: boolean;
  isActive?: boolean | null;
  demande?: Record<string, unknown> | null;
} = {}) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const tx = {
    demande: {
      findUnique: vi.fn(async () => options.demande ?? null),
      updateMany,
      findFirst: vi.fn(async () => null),
    },
    technicianProfile: {
      findUnique: vi.fn(async () => ({
        isAvailable: options.isAvailable ?? true,
        kycStatus: options.kycStatus ?? 'VERIFIED',
      })),
    },
    user: {
      findUnique: vi.fn(async () =>
        options.isActive === null ? null : { isActive: options.isActive ?? true },
      ),
    },
    demandeEvent: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
    notification: { create: vi.fn(async ({ data }: { data: unknown }) => data) },
  };
  const prisma = {
    technicianProfile: {
      findUnique: vi.fn(async () => ({
        id: 'profile-1',
        userId: 'tech-1',
        city: 'Douala',
        cityId: 'city-a',
        categories: ['plomberie'],
        kycStatus: 'VERIFIED',
      })),
    },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
  };
  const service = new TechnicianService(prisma as never, {} as never, {} as never);
  return { service, updateMany, tx };
}

const OPEN_DEMANDE = {
  id: 'd-1',
  status: 'SUBMITTED',
  category: 'plomberie',
  city: 'Douala',
  cityId: 'city-a',
  zoneId: null,
  clientId: 'c-1',
  technicianId: null,
};

describe('acceptDemande — garde disponibilité/compte en transaction', () => {
  it('isAvailable=false → 403, claim jamais tenté', async () => {
    const { service, updateMany } = mockServiceInTx({ isAvailable: false, demande: OPEN_DEMANDE });
    await expect(service.acceptDemande('tech-1', 'd-1')).rejects.toThrow('indisponible');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('compte désactivé (isActive=false) → 403, claim jamais tenté', async () => {
    const { service, updateMany } = mockServiceInTx({ isActive: false, demande: OPEN_DEMANDE });
    await expect(service.acceptDemande('tech-1', 'd-1')).rejects.toThrow('désactivé');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('compte introuvable → 403, claim jamais tenté', async () => {
    const { service, updateMany } = mockServiceInTx({ isActive: null, demande: OPEN_DEMANDE });
    await expect(service.acceptDemande('tech-1', 'd-1')).rejects.toThrow('désactivé');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('KYC révoqué en transaction → 403, claim jamais tenté', async () => {
    const { service, updateMany } = mockServiceInTx({ kycStatus: 'REJECTED', demande: OPEN_DEMANDE });
    await expect(service.acceptDemande('tech-1', 'd-1')).rejects.toThrow('doit être vérifié');
    expect(updateMany).not.toHaveBeenCalled();
  });
});
