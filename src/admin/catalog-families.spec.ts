import { describe, expect, it, vi } from 'vitest';
import { CatalogService } from './catalog.service.js';

/* Familles d'équipements (parcours « Autre appareil ») : CRUD admin,
 * liste publique (actives seules) et suppression sûre (Prisma simulé). */

function mockPrisma(store: {
  families?: Array<Record<string, unknown>>;
  demandeCount?: number;
}) {
  const families = store.families ?? [];
  return {
    equipmentFamily: {
      findMany: vi.fn(async ({ where }: { where?: Record<string, unknown> }) =>
        families
          .filter((row) => !where || row.isActive === (where as { isActive: boolean }).isActive)
          .map((row) => ({ code: row.code, label: row.label, icon: row.icon })),
      ),
      findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        if ('code' in where) return families.find((row) => row.code === where.code) ?? null;
        return families.find((row) => row.id === where.id) ?? null;
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const { NOT, label, ...scope } = where as Record<string, unknown> & {
          NOT?: { id: string };
          label?: { equals: string; mode?: string };
        };
        return (
          families.find((row) => {
            if (NOT && row.id === NOT.id) return false;
            if (label && String(row.label).toLowerCase() !== String(label.equals).toLowerCase()) return false;
            return Object.entries(scope).every(([key, value]) => row[key] === value);
          }) ?? null
        );
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'new', ...data })),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'f-1', ...data })),
      delete: vi.fn(async () => ({ id: 'f-1' })),
    },
    demande: {
      count: vi.fn(async () => store.demandeCount ?? 0),
    },
  };
}

describe('familles — création admin', () => {
  it('code normalisé en majuscules, catégorie validée', async () => {
    const prisma = mockPrisma({ families: [] });
    const service = new CatalogService(prisma as never);
    const result = await service.createFamily({
      code: ' game_console ',
      label: 'Console / jeu vidéo',
      category: 'electromenager',
    });
    expect((result as Record<string, unknown>).code).toBe('GAME_CONSOLE');
  });

  it('code existant → 400 ; homonyme insensible casse → 400', async () => {
    const prisma = mockPrisma({
      families: [{ id: 'f-1', code: 'GAME_CONSOLE', label: 'Console / jeu vidéo', category: 'electromenager' }],
    });
    const service = new CatalogService(prisma as never);
    await expect(
      service.createFamily({ code: 'game_console', label: 'Autre', category: 'autre' }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.createFamily({ code: 'CONSOLE', label: 'console / JEU vidéo', category: 'autre' }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('catégorie de dispatch invalide → 400', async () => {
    const prisma = mockPrisma({ families: [] });
    const service = new CatalogService(prisma as never);
    await expect(
      service.createFamily({ code: 'X', label: 'X', category: 'cuisine' }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe('familles — liste publique (client)', () => {
  it('actives seules, triées, sans catégorie interne', async () => {
    const prisma = mockPrisma({
      families: [
        { id: 'f-1', code: 'GAME_CONSOLE', label: 'Console', icon: '🎮', isActive: true, sortOrder: 10 },
        { id: 'f-2', code: 'OLD', label: 'Ancien', icon: null, isActive: false, sortOrder: 5 },
      ],
    });
    const service = new CatalogService(prisma as never);
    const result = await service.listPublicFamilies();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ code: 'GAME_CONSOLE', label: 'Console', icon: '🎮' });
  });
});

describe('familles — suppression sûre', () => {
  it('sans demande → suppression physique', async () => {
    const prisma = mockPrisma({
      families: [{ id: 'f-1', code: 'GAME_CONSOLE', label: 'Console', category: 'electromenager' }],
      demandeCount: 0,
    });
    const service = new CatalogService(prisma as never);
    const result = await service.deleteFamily('f-1');
    expect(result).toMatchObject({ action: 'DELETED' });
  });

  it('avec demandes → désactivation, historique conservé', async () => {
    const prisma = mockPrisma({
      families: [{ id: 'f-1', code: 'GAME_CONSOLE', label: 'Console', category: 'electromenager' }],
      demandeCount: 3,
    });
    const service = new CatalogService(prisma as never);
    const result = await service.deleteFamily('f-1');
    expect(result).toMatchObject({ action: 'DEACTIVATED' });
  });
});
