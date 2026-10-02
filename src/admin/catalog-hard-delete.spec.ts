import { describe, expect, it, vi } from 'vitest';
import { CatalogService } from './catalog.service.js';

/* Suppression définitive du catalogue : atomique, enfants supprimés,
 * historique métier préservé (détaché via SetNull, snapshots intacts),
 * slug réutilisable. */

function mockPrisma() {
  const prisma = {
    serviceDomain: {
      findUnique: vi.fn(async () => ({ id: 'dom-1', slug: 'smartphone' })),
      delete: vi.fn(async () => ({ id: 'dom-1' })),
    },
    deviceBrand: { count: vi.fn(async () => 2) },
    problem: { count: vi.fn(async () => 3) },
    demande: { count: vi.fn(async () => 1) },
    catalogDiagnostic: { count: vi.fn(async () => 4) },
    catalogIntervention: { count: vi.fn(async () => 5) },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({ serviceDomain: { delete: vi.fn(async () => ({ id: 'dom-1' })) } }),
    ),
  };
  return prisma;
}

describe('suppression définitive du catalogue', () => {
  it('supprime en transaction atomique et rapporte les enfants', async () => {
    const prisma = mockPrisma();
    const service = new CatalogService(prisma as never);
    const outcome = await service.deleteDomainHard('dom-1');
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ action: 'HARD_DELETED', id: 'dom-1' });
    expect(outcome.message).toMatch(/irréversible/i);
    expect(outcome.deleted).toMatchObject({ marques: 2, demandesDetachees: 1 });
  });

  it('domaine introuvable → 404', async () => {
    const prisma = mockPrisma();
    prisma.serviceDomain.findUnique = (vi.fn(async () => null) as unknown) as typeof prisma.serviceDomain.findUnique;
    const service = new CatalogService(prisma as never);
    await expect(service.deleteDomainHard('missing')).rejects.toMatchObject({ status: 404 });
  });

  it('échec transaction → rollback (delete non validé, erreur propagée)', async () => {
    const prisma = mockPrisma();
    prisma.$transaction = vi.fn(async () => {
      throw new Error('DB down');
    });
    const service = new CatalogService(prisma as never);
    await expect(service.deleteDomainHard('dom-1')).rejects.toThrow('DB down');
  });
});
