import { describe, expect, it, vi } from 'vitest';
import { AdminService } from './admin.service.js';
import { CatalogService } from './catalog.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/* Sprint ADMIN SUPER POWERS — vérifications métier (Prisma mocké, aucune
 * base requise) : suppressions catalogue, comptes, message admin. */

function adminService(prisma: unknown) {
  return new AdminService(prisma as PrismaService, {} as never);
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
      technicianZoneCoverage: { count: vi.fn(async () => 0) },
      demande: { count: vi.fn(async () => 0) },
    };
    const outcome = await catalogService(prisma).deleteZone('z1');
    expect(outcome.action).toBe('DELETED');
    expect(prisma.zone.delete).toHaveBeenCalledWith({ where: { id: 'z1' } });
    expect(prisma.zone.update).not.toHaveBeenCalled();
  });

  it('zone avec couvertures → DEACTIVATED (isActive = false, historique conservé)', async () => {
    const prisma = {
      zone: {
        findUnique: vi.fn(async () => ({ id: 'z1', isActive: true })),
        delete: vi.fn(),
        update: vi.fn(async () => ({ id: 'z1', isActive: false })),
      },
      technicianZoneCoverage: { count: vi.fn(async () => 3) },
      demande: { count: vi.fn(async () => 0) },
    };
    const outcome = await catalogService(prisma).deleteZone('z1');
    expect(outcome.action).toBe('DEACTIVATED');
    expect(prisma.zone.delete).not.toHaveBeenCalled();
    expect(prisma.zone.update).toHaveBeenCalledWith({
      where: { id: 'z1' },
      data: { isActive: false },
    });
    expect(outcome.blockers.couvertures).toBe(3);
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
      technicianZoneCoverage: { count: vi.fn(async () => 0) },
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
    dispatchWave: { count: vi.fn(async () => 0) },
    demandeEvent: { count: vi.fn(async () => 0) },
    review: { count: vi.fn(async () => 0) },
    kycDocument: { count: vi.fn(async () => 0) },
    kycReview: { count: vi.fn(async () => 0) },
    technicianProfile: { count: vi.fn(async () => 0) },
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

describe('message ADMIN → TECHNICIEN par email', () => {
  const tech = {
    id: 't1',
    role: 'TECHNICIAN',
    firstName: 'Awa',
    lastName: 'Diallo',
    email: 'tech@email.com',
    isActive: true,
  };

  it('email normalisé (casse + espaces) et notification ADMIN_MESSAGE sans mission', async () => {
    const prisma = {
      user: { findUnique: vi.fn(async () => tech) },
      notification: {
        create: vi.fn(async (args: { data: Record<string, unknown> }) => ({
          id: 'n1',
          createdAt: new Date('2026-09-22T00:00:00Z'),
          ...args.data,
        })),
      },
    };
    const result = await adminService(prisma).sendTechnicianMessage(
      'admin1',
      '  TECH@Email.COM ',
      'Votre KYC doit être complété.',
    );
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: 'tech@email.com' },
      select: expect.anything(),
    });
    expect(prisma.notification.create).toHaveBeenCalledWith({
      data: {
        userId: 't1',
        demandeId: null,
        type: 'ADMIN_MESSAGE',
        title: 'Message de Relio',
        message: 'Votre KYC doit être complété.',
      },
    });
    expect(result.technician.email).toBe('tech@email.com');
  });

  it('email inexistant → 404 ; compte CLIENT → 400 ; compte désactivé → 400', async () => {
    const missing = { user: { findUnique: vi.fn(async () => null) }, notification: { create: vi.fn() } };
    await expect(adminService(missing).sendTechnicianMessage('a', 'x@y.z', 'msg')).rejects.toMatchObject({ status: 404 });

    const client = {
      user: { findUnique: vi.fn(async () => ({ ...tech, role: 'CLIENT' })) },
      notification: { create: vi.fn() },
    };
    await expect(adminService(client).sendTechnicianMessage('a', 'x@y.z', 'msg')).rejects.toMatchObject({ status: 400 });

    const inactive = {
      user: { findUnique: vi.fn(async () => ({ ...tech, isActive: false })) },
      notification: { create: vi.fn() },
    };
    await expect(adminService(inactive).sendTechnicianMessage('a', 'x@y.z', 'msg')).rejects.toMatchObject({ status: 400 });
    expect(missing.notification.create).not.toHaveBeenCalled();
    expect(client.notification.create).not.toHaveBeenCalled();
    expect(inactive.notification.create).not.toHaveBeenCalled();
  });
});
