import { ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TechnicianService } from './technician.service.js';

/* §11 — blocage à l'ACTIVATION. Le contrôle est backend (source de vérité) et
 * porte sur la date EFFECTIVE : envoyer `isAvailable: true` puis corriger
 * `birthDate` ensuite ne doit pas permettre de contourner la majorité. */

type PrismaMock = {
  technicianProfile: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  equipmentFamily: { findMany: ReturnType<typeof vi.fn> };
  /* `completedInterventionsCount` l'est à chaque sérialisation du profil. */
  demande: { count: ReturnType<typeof vi.fn> };
};

function makeService(prisma: PrismaMock) {
  return new TechnicianService(prisma as never, {} as never, {} as never);
}

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

/** Dates fixes : le test ne doit pas dépendre de la date du jour. */
const NOW = d('2025-10-04');
const TWENTY_YEARS_AGO_PLUS_ONE_DAY = d('2005-10-05'); // 19 ans
const EIGHTEEN_YEARS_AGO_PLUS_ONE_DAY = d('2007-10-05'); // 17 ans
// (18 ans pile : cf. le test ci-dessous.)

function profileRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'p1',
    userId: 'tech-1',
    city: 'Douala',
    cityId: 'city-a',
    categories: ['plomberie'],
    isAvailable: false,
    avatarUrl: null,
    bio: null,
    experience: null,
    serviceDescription: null,
    specialties: [],
    kycStatus: 'NOT_SUBMITTED',
    kycRejectionReason: null,
    activityType: null,
    experienceYears: null,
    familyCodes: [],
    birthDate: null,
    nationality: null,
    kycIdentityDocType: null,
    lastLatitude: null,
    lastLongitude: null,
    locationUpdatedAt: null,
    createdAt: NOW,
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

describe('updateProfile — majorité à l’activation (§11)', () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    prisma = {
      technicianProfile: { findUnique: vi.fn(), update: vi.fn() },
      equipmentFamily: { findMany: vi.fn().mockResolvedValue([]) },
      demande: { count: vi.fn().mockResolvedValue(0) },
    };
    prisma.technicianProfile.update.mockImplementation(
      ({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve(profileRow({ ...data })),
    );
    prisma.technicianProfile.findUnique.mockResolvedValue(profileRow());
  });

  it('mineur essayant de s’activer → 403', async () => {
    const service = makeService(prisma);
    await expect(
      service.updateProfile('tech-1', { isAvailable: true, birthDate: '2007-10-05' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.technicianProfile.update).not.toHaveBeenCalled();
  });

  it('exactement 18 ans le jour de l’anniversaire → accepté', async () => {
    const service = makeService(prisma);
    await expect(
      service.updateProfile('tech-1', { isAvailable: true, birthDate: '2007-10-04' }),
    ).resolves.toBeTruthy();
    expect(prisma.technicianProfile.update).toHaveBeenCalled();
  });

  it('majeur → accepté', async () => {
    const service = makeService(prisma);
    await expect(
      service.updateProfile('tech-1', { isAvailable: true, birthDate: '1990-01-01' }),
    ).resolves.toBeTruthy();
  });

  it('date de naissance MODIFIÉE vers une date mineure au moment d’activer → 403', async () => {
    prisma.technicianProfile.findUnique.mockResolvedValue(
      profileRow({ birthDate: TWENTY_YEARS_AGO_PLUS_ONE_DAY }),
    );
    const service = makeService(prisma);
    // Impossible de s'activer puis de corriger la date : le contrôle porte sur
    // la date effective (celle du DTO si fournie).
    await expect(
      service.updateProfile('tech-1', {
        isAvailable: true,
        birthDate: '2007-10-05',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('le contrôle porte sur la date DÉJÀ stockée si le DTO n’en fournit pas', async () => {
    prisma.technicianProfile.findUnique.mockResolvedValue(
      profileRow({ birthDate: EIGHTEEN_YEARS_AGO_PLUS_ONE_DAY }),
    );
    const service = makeService(prisma);
    await expect(service.updateProfile('tech-1', { isAvailable: true })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('mineur PEUT modifier son profil tant qu’il ne s’active pas', async () => {
    const service = makeService(prisma);
    await expect(
      service.updateProfile('tech-1', { bio: 'Technicien débutant', birthDate: '2007-10-05' }),
    ).resolves.toBeTruthy();
  });

  it('désactiver la disponibilité n’est jamais bloqué par l’âge', async () => {
    prisma.technicianProfile.findUnique.mockResolvedValue(
      profileRow({ birthDate: EIGHTEEN_YEARS_AGO_PLUS_ONE_DAY, isAvailable: true }),
    );
    const service = makeService(prisma);
    await expect(service.updateProfile('tech-1', { isAvailable: false })).resolves.toBeTruthy();
  });

  it('contournement « effacer la date ET s’activer » → 403', async () => {
    // Un mineur NE doit pas pouvoir envoyer { birthDate: null, isAvailable:
    // true } : la date en base est mineure, le garde-fou « pas de donnée »
    // ne doit pas s'appliquer dès qu'on cherche à l'effacer.
    prisma.technicianProfile.findUnique.mockResolvedValue(
      profileRow({ birthDate: EIGHTEEN_YEARS_AGO_PLUS_ONE_DAY }),
    );
    const service = makeService(prisma);
    await expect(
      service.updateProfile('tech-1', { isAvailable: true, birthDate: null }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.technicianProfile.update).not.toHaveBeenCalled();
  });

  it('un majeur peut effacer sa date SANS s’activer (mise à jour partielle autorisée)', async () => {
    prisma.technicianProfile.findUnique.mockResolvedValue(
      profileRow({ birthDate: d('1990-01-01') }),
    );
    const service = makeService(prisma);
    await expect(service.updateProfile('tech-1', { birthDate: null })).resolves.toBeTruthy();
  });

  it('grandfather : technicien sans birthDate reste activable (pas de régression)', async () => {
    prisma.technicianProfile.findUnique.mockResolvedValue(profileRow({ birthDate: null }));
    const service = makeService(prisma);
    await expect(service.updateProfile('tech-1', { isAvailable: true })).resolves.toBeTruthy();
    // …mais l'API l'invite à compléter son dossier KYC.
    const result = await service.updateProfile('tech-1', { isAvailable: true });
    expect(result.mustCompleteKycProfile).toBe(true);
  });

  it('majeur : mustCompleteKycProfile passe à false', async () => {
    prisma.technicianProfile.findUnique.mockResolvedValue(profileRow({ birthDate: NOW }));
    const service = makeService(prisma);
    // Le mock d'`update` fusionne `data` sur la ligne de base : sans donnée
    // de naissance dans le DTO, la ligne retournée conserve `birthDate`.
    prisma.technicianProfile.update.mockResolvedValue(profileRow({ birthDate: NOW }));
    const result = await service.updateProfile('tech-1', {});
    expect(result.mustCompleteKycProfile).toBe(false);
  });

  it('date de naissance future → 400', async () => {
    const service = makeService(prisma);
    await expect(service.updateProfile('tech-1', { birthDate: '2999-01-01' })).rejects.toThrow(
      /Date de naissance invalide/,
    );
  });

  it('avatarUrl n’est plus modifiable via PATCH profile (bucket contrôlé uniquement)', async () => {
    const service = makeService(prisma);
    // La DTO ne déclare plus `avatarUrl` : la ValidationPipe globale
    // (forbidNonWhitelisted) rejette le champ avant le service.
    const dto = { avatarUrl: 'https://pirate.example.com/x.png' } as never;
    await service.updateProfile('tech-1', dto).catch(() => undefined);
    // Le service ne doit jamais écrire un avatarUrl issu du DTO.
    const written = prisma.technicianProfile.update.mock.calls[0]?.[0]?.data ?? {};
    expect(written).not.toHaveProperty('avatarUrl');
  });
});

describe('updateProfile — validation des champs professionnels', () => {
  let prisma: PrismaMock;

  beforeEach(() => {
    prisma = {
      technicianProfile: { findUnique: vi.fn(), update: vi.fn() },
      equipmentFamily: { findMany: vi.fn().mockResolvedValue([]) },
      demande: { count: vi.fn().mockResolvedValue(0) },
    };
    prisma.technicianProfile.findUnique.mockResolvedValue(profileRow());
    prisma.technicianProfile.update.mockImplementation(({ data }: { data: Record<string, unknown> }) =>
      Promise.resolve(profileRow({ ...data })),
    );
  });

  it('familyCodes : doublons compactés et triés', async () => {
    prisma.equipmentFamily.findMany.mockResolvedValue([
      { code: 'CONSOLE' },
      { code: 'TABLETTE' },
    ]);
    const service = makeService(prisma);
    await service.updateProfile('tech-1', { familyCodes: ['TABLETTE', 'CONSOLE', 'CONSOLE'] });
    // La requête de vérification reçoit les codes COMPACTÉS (le doublon
    // CONSOLE est retiré) et validés comme ACTIFS. La valeur persistée est,
    // elle, triée (ordre déterministe indépendant de l'ordre de saisie).
    expect(prisma.equipmentFamily.findMany).toHaveBeenCalledWith({
      where: { code: { in: ['CONSOLE', 'TABLETTE'] }, isActive: true },
      select: { code: true },
    });
    const written = prisma.technicianProfile.update.mock.calls[0]?.[0]?.data;
    expect(written.familyCodes).toEqual(['CONSOLE', 'TABLETTE']);
  });

  it('familyCodes : code inconnu ou désactivé → 400 (jamais accepté « à l’aveugle »)', async () => {
    prisma.equipmentFamily.findMany.mockResolvedValue([]); // aucun code connu
    const service = makeService(prisma);
    await expect(
      service.updateProfile('tech-1', { familyCodes: ['FAMILLE_INEXISTANTE'] }),
    ).rejects.toThrow(/Famille d'équipement inconnue/);
  });

  it('familyCodes : liste vide autorisée = aucune préférence déclarée', async () => {
    const service = makeService(prisma);
    await service.updateProfile('tech-1', { familyCodes: [] });
    const written = prisma.technicianProfile.update.mock.calls[0]?.[0]?.data;
    expect(written.familyCodes).toEqual([]);
  });

  it('nationalité : code valide normalisé en majuscules', async () => {
    const service = makeService(prisma);
    await service.updateProfile('tech-1', { nationality: 'cm' });
    const written = prisma.technicianProfile.update.mock.calls[0]?.[0]?.data;
    expect(written.nationality).toBe('CM');
  });

  it('nationalité : code hors nomenclature → 400', async () => {
    const service = makeService(prisma);
    await expect(service.updateProfile('tech-1', { nationality: 'ZZ' })).rejects.toThrow(
      /Nationalité invalide/,
    );
  });

  it('activityType / experienceYears / bio écrits tels que déclarés', async () => {
    const service = makeService(prisma);
    await service.updateProfile('tech-1', {
      activityType: 'FREELANCE',
      experienceYears: 7,
      bio: 'Spécialiste smartphones et ordinateurs.',
    });
    const written = prisma.technicianProfile.update.mock.calls[0]?.[0]?.data;
    expect(written.activityType).toBe('FREELANCE');
    expect(written.experienceYears).toBe(7);
    expect(written.bio).toBe('Spécialiste smartphones et ordinateurs.');
  });

  it('une valeur absente du DTO ne touche pas la colonne (mise à jour partielle)', async () => {
    const service = makeService(prisma);
    await service.updateProfile('tech-1', { bio: 'Nouvelle bio' });
    const written = prisma.technicianProfile.update.mock.calls[0]?.[0]?.data;
    expect(written).toEqual({ bio: 'Nouvelle bio' });
    expect(written).not.toHaveProperty('specialties');
    expect(written).not.toHaveProperty('activityType');
  });
});
