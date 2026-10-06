import { describe, expect, it, vi } from 'vitest';
import { TechnicianService } from './technician.service.js';

/* Chantier #5B — ville de référence depuis `PATCH /technician/profile`.
 *
 * C'est ce chemin qui débloque `/technicien/zones` : sans lui, la page ne peut
 * proposer qu'un lien vers le profil (la boucle du Problème 2 de l'audit).
 *
 * Invariant central : `cityId` est une donnée de RÉFÉRENCE. Le nom affiché
 * vient de `ServiceCity`, jamais du client, et `User.city` / `User.cityId`
 * sont alignés — sinon le technicien verrait ses zones calculées depuis une
 * ville et ses missions filtrées depuis une autre.
 *
 * Prisma mocké : aucune base requise.
 */

const DOUALA = { id: 'city-a', name: 'Douala', slug: 'douala', isActive: true };
const YAOUNDE = { id: 'city-b', name: 'Yaoundé', slug: 'yaounde', isActive: true };
const DESACTIVEE = { id: 'city-c', name: 'Ville Retirée', slug: 'ville-retiree', isActive: false };

/** Profil déjà rattaché (cas nominal : le technicien a une ville).
 *  Shape COMPLET : le sérialiseur appelle `toISOString()` sur `createdAt` et
 *  lit la relation `user` — un mock amputé échouerait pour une raison
 *  étrangère au code testé. */
function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    userId: 'tech-1',
    city: DOUALA.name,
    cityId: DOUALA.id,
    categories: ['plomberie'],
    isAvailable: false,
    avatarUrl: null,
    bio: null,
    experience: null,
    serviceDescription: null,
    specialties: [],
    activityType: null,
    experienceYears: null,
    familyCodes: [],
    birthDate: null,
    nationality: null,
    kycIdentityDocType: null,
    kycStatus: 'NOT_SUBMITTED',
    kycRejectionReason: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    user: {
      firstName: 'Jean',
      lastName: 'Dupont',
      phone: null,
      email: 'j@example.com',
      role: 'TECHNICIAN',
    },
    ...overrides,
  };
}

function harness(options: { existing?: Record<string, unknown> | null } = {}) {
  const existing = options.existing === undefined ? profileRow() : options.existing;
  const cities = [DOUALA, YAOUNDE, DESACTIVEE];

  const profileUpdates: Array<Record<string, unknown>> = [];
  const userUpdates: Array<Record<string, unknown>> = [];

  const prisma = {
    technicianProfile: {
      findUnique: vi.fn(async () => (existing ? { ...existing } : null)),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        profileUpdates.push(data);
        return profileRow({ ...existing, ...data });
      }),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        profileUpdates.push(data);
        return profileRow({ ...data });
      }),
    },
    user: {
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        userUpdates.push(data);
        return { id: 'tech-1' };
      }),
    },
    serviceCity: {
      findMany: vi.fn(async () => cities.filter((c) => c.isActive)),
      findFirst: vi.fn(async ({ where }: { where: { id: string; isActive: boolean } }) =>
        cities.find((c) => c.id === where.id && c.isActive === where.isActive) ?? null,
      ),
    },
    equipmentFamily: { findMany: vi.fn(async () => []) },
    demande: { count: vi.fn(async () => 0) },
  };

  const service = new TechnicianService(prisma as never, {} as never, {} as never);
  return { service, prisma, profileUpdates, userUpdates };
}

describe('updateProfile — ville de référence structurée (chantier #5B)', () => {
  it('cityId valide → profil ET compte alignés sur le nom du référentiel', async () => {
    const { service, prisma, profileUpdates, userUpdates } = harness();

    await service.updateProfile('tech-1', { cityId: YAOUNDE.id } as never);

    expect(prisma.technicianProfile.update).toHaveBeenCalledTimes(1);
    expect(profileUpdates[0]).toMatchObject({ city: YAOUNDE.name, cityId: YAOUNDE.id });
    /* Sans cet alignement, le dispatch filtrerait sur l'ancienne ville. */
    expect(userUpdates[0]).toMatchObject({ city: YAOUNDE.name, cityId: YAOUNDE.id });
  });

  it('cityId inconnu → 400, RIEN n’est écrit (ni profil ni compte)', async () => {
    const { service, prisma, profileUpdates, userUpdates } = harness();

    await expect(
      service.updateProfile('tech-1', { cityId: 'city-inexistante' } as never),
    ).rejects.toThrow(/Ville introuvable/i);

    expect(prisma.technicianProfile.update).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(profileUpdates).toHaveLength(0);
    expect(userUpdates).toHaveLength(0);
  });

  it('cityId d’une ville DÉSACTIVÉE → 400 (ville retirée du service)', async () => {
    const { service, prisma } = harness();

    await expect(
      service.updateProfile('tech-1', { cityId: DESACTIVEE.id } as never),
    ).rejects.toThrow(/Ville introuvable/i);
    expect(prisma.technicianProfile.update).not.toHaveBeenCalled();
  });

  it('cityId prime sur `city` : le texte du client ne peut pas divorcer l’affichage', async () => {
    const { service, profileUpdates } = harness();

    await service.updateProfile('tech-1', {
      cityId: YAOUNDE.id,
      city: 'Ville Inventée',
    } as never);

    expect(profileUpdates[0]).toMatchObject({ city: YAOUNDE.name, cityId: YAOUNDE.id });
  });

  it('texte `city` seul → comportement historique conservé (résolution non bloquante)', async () => {
    const { service, profileUpdates, userUpdates } = harness();

    await service.updateProfile('tech-1', { city: 'Yaoundé' } as never);

    expect(profileUpdates[0]).toMatchObject({ city: 'Yaoundé', cityId: YAOUNDE.id });
    /* Le chemin texte n'aligne PAS le compte : aucune régression de comportement. */
    expect(userUpdates).toHaveLength(0);
  });

  it('texte `city` sans correspondance → cityId remis à null (règle D 8.8.2)', async () => {
    const { service, profileUpdates } = harness();

    await service.updateProfile('tech-1', { city: 'Endroit Inconnu' } as never);

    expect(profileUpdates[0]).toMatchObject({ city: 'Endroit Inconnu', cityId: null });
  });

  it('aucun changement de ville → ni profil ni compte réécrits', async () => {
    const { service, prisma, userUpdates } = harness();

    await service.updateProfile('tech-1', { bio: 'Nouveau texte' } as never);

    expect(userUpdates).toHaveLength(0);
    const written = (prisma.technicianProfile.update as ReturnType<typeof vi.fn>).mock
      .calls[0]![0].data as Record<string, unknown>;
    expect(written).not.toHaveProperty('city');
    expect(written).not.toHaveProperty('cityId');
  });

  it('profil INEXISTANT + cityId seul → créé rattaché (le Select suffit)', async () => {
    const { service, prisma, profileUpdates } = harness({ existing: null });

    await service.updateProfile('tech-1', {
      cityId: YAOUNDE.id,
      categories: ['plomberie'],
    } as never);

    expect(prisma.technicianProfile.create).toHaveBeenCalledTimes(1);
    expect(profileUpdates[0]).toMatchObject({ city: YAOUNDE.name, cityId: YAOUNDE.id });
  });

  it('profil INEXISTANT + cityId INCONNU → 400, rien n’est créé', async () => {
    const { service, prisma } = harness({ existing: null });

    await expect(
      service.updateProfile('tech-1', {
        cityId: 'city-inexistante',
        categories: ['plomberie'],
      } as never),
    ).rejects.toThrow(/Ville introuvable/i);
    expect(prisma.technicianProfile.create).not.toHaveBeenCalled();
  });
});