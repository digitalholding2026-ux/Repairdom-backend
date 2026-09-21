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
