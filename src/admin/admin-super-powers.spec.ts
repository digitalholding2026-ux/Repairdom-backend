import { describe, expect, it, vi } from 'vitest';
import { AdminService } from './admin.service.js';
import { CatalogService } from './catalog.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/* Sprint ADMIN SUPER POWERS — vérifications métier (Prisma mocké, aucune
 * base requise) : suppressions catalogue et comptes. */

function adminService(prisma: unknown) {
  return new AdminService(prisma as PrismaService);
}

function catalogService(prisma: unknown) {
  return new CatalogService(prisma as PrismaService);
}

describe('suppressions catalogue : physique si sûr, désactivation sinon', () => {
  it('zone sans dépendance → DELETED (suppression physique)', async () => {
    const prisma = {
      zone: {
        findUnique: vi.fn(async () => ({ id: 'z1' })),
        delete: vi.fn(async () => ({ id: 'z1' })),
        update: vi.fn(),
      },
      demande: { count: vi.fn(async () => 0) },
    };
    const outcome = await catalogService(prisma).deleteZone('z1');
    expect(outcome.action).toBe('DELETED');
    expect(prisma.zone.delete).toHaveBeenCalledWith({ where: { id: 'z1' } });
    expect(prisma.zone.update).not.toHaveBeenCalled();
  });

  it('zone avec missions → DEACTIVATED (isActive = false, historique conservé)', async () => {
    const prisma = {
      zone: {
        findUnique: vi.fn(async () => ({ id: 'z1', isActive: true })),
        delete: vi.fn(),
        update: vi.fn(async () => ({ id: 'z1', isActive: false })),
      },
      demande: { count: vi.fn(async () => 3) },
    };
    const outcome = await catalogService(prisma).deleteZone('z1');
    expect(outcome.action).toBe('DEACTIVATED');
    expect(prisma.zone.delete).not.toHaveBeenCalled();
    expect(prisma.zone.update).toHaveBeenCalledWith({
      where: { id: 'z1' },
      data: { isActive: false },
    });
    expect(outcome.blockers.demandes).toBe(3);
  });

  it('tarif avec historique → DEACTIVATED + entrée PricingHistory (journal jamais amputé)', async () => {
    const prisma = {
      pricing: {
        findUnique: vi.fn(async () => ({ id: 'p1', isActive: true })),
        delete: vi.fn(),
        update: vi.fn(async () => ({})),
      },
      pricingHistory: {
        count: vi.fn(async () => 2),
        create: vi.fn(async () => ({})),
      },
      $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) => cb(prisma)),
    };
    const outcome = await catalogService(prisma).deletePricing('i1', 'admin1');
    expect(outcome.action).toBe('DEACTIVATED');
    expect(prisma.pricing.delete).not.toHaveBeenCalled();
    expect(prisma.pricingHistory.create).toHaveBeenCalled();
  });

  it('tarif sans historique → DELETED', async () => {
    const prisma = {
      pricing: {
        findUnique: vi.fn(async () => ({ id: 'p1', isActive: true })),
        delete: vi.fn(async () => ({})),
      },
      pricingHistory: { count: vi.fn(async () => 0) },
    };
    const outcome = await catalogService(prisma).deletePricing('i1', 'admin1');
    expect(outcome.action).toBe('DELETED');
  });

  it('élément inexistant → 404', async () => {
    const prisma = {
      zone: { findUnique: vi.fn(async () => null) },
      demande: { count: vi.fn(async () => 0) },
    };
    await expect(catalogService(prisma).deleteZone('nope')).rejects.toMatchObject({
      status: 404,
    });
  });
});

describe('gestion des comptes : suppression physique ou désactivation', () => {
  const emptyCounts = {
    demande: { count: vi.fn(async () => 0) },
    message: { count: vi.fn(async () => 0) },
    diagnostic: { count: vi.fn(async () => 0) },
    quote: { count: vi.fn(async () => 0) },
    notification: { count: vi.fn(async () => 0) },
    financialTransaction: { count: vi.fn(async () => 0) },
    demandeEvent: { count: vi.fn(async () => 0) },
    review: { count: vi.fn(async () => 0) },
  };

  it('compte sans donnée liée → DELETED (user.delete appelé)', async () => {
    const prisma = {
      ...emptyCounts,
      user: {
        findUnique: vi.fn(async () => ({ id: 'u1', role: 'CLIENT', isActive: true })),
        delete: vi.fn(async () => ({})),
        update: vi.fn(),
      },
    };
    const outcome = await adminService(prisma).deleteUserAccount('admin1', 'u1');
    expect(outcome.action).toBe('DELETED');
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'u1' } });
  });

  it('client avec missions → DEACTIVATED (delete jamais appelé, connexion bloquée)', async () => {
    const prisma = {
      ...emptyCounts,
      demande: { count: vi.fn(async (args: { where: object }) => ('clientId' in args.where ? 2 : 0)) },
      user: {
        findUnique: vi.fn(async () => ({ id: 'u1', role: 'CLIENT', isActive: true })),
        delete: vi.fn(),
        update: vi.fn(async () => ({})),
      },
    };
    const outcome = await adminService(prisma).deleteUserAccount('admin1', 'u1');
    expect(outcome.action).toBe('DEACTIVATED');
    expect(prisma.user.delete).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { isActive: false },
    });
    expect(outcome.dependencies.demandesClient).toBe(2);
  });

  it('compte ADMIN → refus ; soi-même → refus', async () => {
    const prisma = {
      ...emptyCounts,
      user: {
        findUnique: vi.fn(async () => ({ id: 'a2', role: 'ADMIN', isActive: true })),
        delete: vi.fn(),
        update: vi.fn(),
      },
    };
    await expect(adminService(prisma).deleteUserAccount('admin1', 'a2')).rejects.toMatchObject({
      status: 403,
    });
    await expect(adminService(prisma).deleteUserAccount('admin1', 'admin1')).rejects.toMatchObject({
      status: 400,
    });
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });
});
