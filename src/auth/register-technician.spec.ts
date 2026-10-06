import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';

/* Chantier #5B — la ville devient une RÉFÉRENCE obligatoire à l'inscription
 * du technicien.
 *
 * Ce que ces tests verrouillent :
 *  1. EXIGENCE — un technicien sans `cityId` est refusé, et rien n'est écrit ;
 *  2. INTÉGRITÉ — un `cityId` inconnu ou désactivé est refusé (jamais deviné) ;
 *  3. COHÉRENCE — `User.cityId` ET `TechnicianProfile.cityId` sont renseignés,
 *     et `city` vient du `ServiceCity.name` (et NON du client) ;
 *  4. NON-RÉGRESSION — un CLIENT s'inscrit exactement comme avant : texte libre
 *     accepté, rattachement best-effort inchangé.
 *
 * Prisma entièrement mocké : aucune base requise.
 */

const DOUALA = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Douala',
  slug: 'douala',
  isActive: true,
};
const YAOUNDE = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'Yaoundé',
  slug: 'yaounde',
  isActive: true,
};
const DESACTIVEE = {
  id: '33333333-3333-4333-8333-333333333333',
  name: 'Ville Retirée',
  slug: 'ville-retiree',
  isActive: false,
};

/**
 * Prisma mocké. `cities` est le référentiel `ServiceCity` : `findFirst`
 * applique le filtre `isActive` comme le fait la vraie requête, pour que les
 * tests exercent vraiment le cas « ville désactivée ».
 */
function harness(cities: Array<typeof DOUALA> = [DOUALA, YAOUNDE]) {
  const createdUsers: Array<Record<string, unknown>> = [];
  const createdProfiles: Array<Record<string, unknown>> = [];
  const updatedUsers: Array<Record<string, unknown>> = [];

  const prisma = {
    user: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdUsers.push(data);
        return { id: 'u-1', emailVerified: false, isActive: true, createdAt: new Date(), ...data };
      }),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        updatedUsers.push(data);
        return { id: 'u-1' };
      }),
    },
    technicianProfile: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        createdProfiles.push(data);
        return { id: 'p-1', ...data };
      }),
    },
    serviceCity: {
      findMany: vi.fn(async () => cities.filter((c) => c.isActive)),
      findFirst: vi.fn(async ({ where }: { where: { id: string; isActive: boolean } }) =>
        cities.find((c) => c.id === where.id && c.isActive === where.isActive) ?? null,
      ),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ user: prisma.user, technicianProfile: prisma.technicianProfile }),
    ),
  };

  const email = { sendVerificationEmail: vi.fn(async () => undefined) };
  const config = { get: vi.fn(() => 'https://app.relioo.space') };
  const service = new AuthService(
    prisma as never,
    config as never,
    email as never,
    {} as never,
  );
  return { service, prisma, createdUsers, createdProfiles, updatedUsers, email };
}

/** Payload technicien valide, avec la ville overwritten si fourni. */
function technicianPayload(overrides: Record<string, unknown> = {}) {
  return {
    firstName: 'Awa',
    lastName: 'Ndo',
    phone: '+237690000000',
    email: 'awa@example.cm',
    password: 'Motdepasse1!',
    role: 'TECHNICIAN' as const,
    categories: ['plomberie'],
    cityId: DOUALA.id,
    ...overrides,
  };
}

describe('register TECHNICIAN — ville de référence obligatoire (chantier #5B)', () => {
  it('sans cityId → 400, aucun compte créé', async () => {
    const { service, prisma, createdUsers, createdProfiles } = harness();
    const payload = technicianPayload();
    delete (payload as { cityId?: string }).cityId;

    await expect(service.register(payload as never)).rejects.toThrow(
      /Ville obligatoire pour un compte technicien/i,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(createdUsers).toHaveLength(0);
    expect(createdProfiles).toHaveLength(0);
  });

  it('cityId qui n’existe pas → 400 « Ville introuvable », aucun compte créé', async () => {
    const { service, prisma } = harness();

    await expect(
      service.register(
        technicianPayload({ cityId: '99999999-9999-4999-8999-999999999999' }) as never,
      ),
    ).rejects.toThrow(/Ville introuvable/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('cityId d’une ville DÉSACTIVÉE → 400 (une ville retirée n’est pas rattachable)', async () => {
    const { service, prisma } = harness([DOUALA, DESACTIVEE]);

    await expect(
      service.register(technicianPayload({ cityId: DESACTIVEE.id }) as never),
    ).rejects.toThrow(/Ville introuvable/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('cityId valide → User ET TechnicianProfile rattachés, nom issu du référentiel', async () => {
    const { service, createdUsers, createdProfiles, email } = harness();

    await service.register(technicianPayload({ cityId: YAOUNDE.id }) as never);

    expect(createdUsers).toHaveLength(1);
    expect(createdProfiles).toHaveLength(1);
    /* Les DEUX tables portent la référence : le dispatch lit le compte, le
     * calcul des zones lit le profil. */
    expect(createdUsers[0]).toMatchObject({ cityId: YAOUNDE.id, city: YAOUNDE.name });
    expect(createdProfiles[0]).toMatchObject({
      cityId: YAOUNDE.id,
      city: YAOUNDE.name,
      categories: ['plomberie'],
    });
    /* Technicien : vérifié d'office, donc AUCUN e-mail de vérification. */
    expect(email.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('le texte `city` envoyé par le client est IGNORÉ (le nom fait foi : ServiceCity)', async () => {
    // Un frontend ancien qui enverrait encore `city` ne doit pas pouvoir
    // divorced l'affichage du référentiel.
    const { service, createdUsers } = harness();

    await service.register(
      technicianPayload({ cityId: DOUALA.id, city: 'Ville Inventée' }) as never,
    );

    expect(createdUsers[0]).toMatchObject({ city: DOUALA.name, cityId: DOUALA.id });
  });

  it('sans catégories → 400 (la ville ne dispense pas des compétences)', async () => {
    const { service, prisma } = harness();

    await expect(
      service.register(technicianPayload({ categories: [] }) as never),
    ).rejects.toThrow(/catégorie de réparation/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('sans téléphone → 400 (garde existante préservée)', async () => {
    const { service, prisma } = harness();
    const payload = technicianPayload();
    delete (payload as { phone?: string }).phone;

    await expect(service.register(payload as never)).rejects.toThrow(/téléphone/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

describe('register CLIENT — comportement inchangé (chantier #5B)', () => {
  const clientPayload = (overrides: Record<string, unknown> = {}) => ({
    firstName: 'Ibrahim',
    lastName: 'Sali',
    email: 'ibrahim@example.cm',
    password: 'Motdepasse1!',
    role: 'CLIENT' as const,
    city: 'Douala',
    address: 'Rue Joss, Akwa',
    ...overrides,
  });

  it('sans cityId → succès (la ville reste un texte libre côté client)', async () => {
    const { service, createdUsers, createdProfiles, email } = harness();

    await service.register(clientPayload() as never);

    expect(createdUsers).toHaveLength(1);
    expect(createdProfiles).toHaveLength(0);
    /* CLIENT : rattachement best-effort inchangé (« Douala » correspond). */
    expect(createdUsers[0]).toMatchObject({ city: 'Douala', cityId: DOUALA.id });
    /* Et l'e-mail de vérification reste envoyé (comportement #2D inchangé). */
    expect(email.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it('texte de ville sans correspondance → cityId null, inscription ACCEPTÉE', async () => {
    // Règle D : non bloquant côté client. Ne pas casser l'inscription client.
    const { service, createdUsers } = harness();

    await service.register(clientPayload({ city: 'Endroit Inconnu' }) as never);

    expect(createdUsers).toHaveLength(1);
    expect(createdUsers[0]).toMatchObject({ city: 'Endroit Inconnu', cityId: null });
  });

  it('sans ville → 400 (garde existante préservée)', async () => {
    const { service, prisma } = harness();
    const payload = clientPayload();
    delete (payload as { city?: string }).city;

    await expect(service.register(payload as never)).rejects.toThrow(/ville/i);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});