import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { ReferralsService } from '../referrals/referrals.service.js';
import type { ModuleRef } from '@nestjs/core';

/* Chantier 4B — CÂBLAGE du rattachement au parrainage à l'INSCRIPTION.
 *
 * Le point le plus sensible n'est pas « le rattachement fonctionne » mais
 * l'INVERSE : le code de parrainage ne doit JAMAIS pouvoir faire échouer une
 * inscription. Un code mal recopié, déjà utilisé, ou le compte du parrain
 * lui-même : dans les trois cas le compte doit être créé et vérifié, et
 * l'inscription doit succeed.
 *
 * On teste donc `AuthService.register` avec un `ModuleRef` double — c'est le
 * mécanisme anti-cycle du chantier : `AuthModule` ne déclare AUCUNE dépendance
 * sur `ReferralsModule`. */

type Row = Record<string, any>;

const DOUALA_ID = '11111111-1111-4111-8111-111111111111';

function harness(options: {
  referrals?: Partial<ReferralsService> | null;
  moduleRefThrows?: boolean;
} = {}) {
  const createdUsers: Row[] = [];

  const prisma = {
    user: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: Row) => {
        createdUsers.push(data);
        return {
          id: 'u-1',
          emailVerified: false,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...data,
        };
      }),
      update: vi.fn(async () => ({ id: 'u-1' })),
    },
    /* Le référentiel `ServiceCity` est consulté à l'inscription (chantier #5B)
     * : sans lui, `register` échouerait sur une ville non résolue — un bruit
     * qui masquerait ce que ces tests doivent vérifier. */
    serviceCity: {
      findMany: vi.fn(async () => [
        { id: DOUALA_ID, name: 'Douala', slug: 'douala', isActive: true },
      ]),
      findFirst: vi.fn(async ({ where }: Row) =>
        where.id === DOUALA_ID
          ? { id: DOUALA_ID, name: 'Douala', slug: 'douala', isActive: true }
          : null,
      ),
    },
    technicianProfile: {
      create: vi.fn(async ({ data }: Row) => ({ id: 'p-1', ...data })),
    },
    $transaction: vi.fn(async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({ user: prisma.user, technicianProfile: prisma.technicianProfile }),
    ),
  };

  const registerReferral =
    options.referrals?.registerReferral ??
    vi.fn(async () => ({ success: true, referralId: 'r1', referrerName: 'Awa' }));

  const referralsService = {
    registerReferral: vi.fn(registerReferral),
  } as unknown as ReferralsService;

  /* `strict: false` est INDISPENSABLE (le service est exporté par
   * `ReferralsModule`, donc dans un autre conteneur) : on l'affirme. */
  const get = options.moduleRefThrows
    ? vi.fn(() => {
        throw new Error('UnknownDependenciesException');
      })
    : vi.fn((token: unknown) => {
        if (options.referrals === null) throw new Error('non trouvé');
        return token === ReferralsService ? referralsService : null;
      });

  const moduleRef = { get } as unknown as ModuleRef;

  const email = { sendVerificationEmail: vi.fn(async () => undefined) };
  const config = { get: vi.fn((key: string) =>
    key === 'FRONTEND_URL' ? 'https://www.relioo.space' : undefined,
  ) };

  const service = new AuthService(
    prisma as never,
    config as never,
    email as never,
    {} as never,
    moduleRef,
  );

  return { service, prisma, createdUsers, moduleRef, get, referralsService, email };
}

function clientPayload(overrides: Row = {}) {
  return {
    firstName: 'Bobi',
    lastName: 'K.',
    email: 'bobi@test.cm',
    password: 'Motdepasse1!',
    role: 'CLIENT' as const,
    city: 'Douala',
    address: 'Rue de la Joie, Akwa',
    ...overrides,
  };
}

describe('AuthService.register — rattachement au parrainage (chantier 4B)', () => {
  it('CLIENT avec code valide → rattachement appelé APRÈS la création', async () => {
    const h = harness();
    const user = await h.service.register(clientPayload({ referralCode: 'relio-abcde' }));

    expect(user).toBeDefined();
    expect(h.referralsService.registerReferral).toHaveBeenCalledWith(
      'u-1',
      'relio-abcde',
      'bobi@test.cm',
    );
    /* Le compte existe avant le rattachement : la ligne Referral le référence
     * par clé étrangère, l'inverse est impossible. */
    expect(h.prisma.user.create).toHaveBeenCalled();
    expect(h.prisma.$transaction).toHaveBeenCalled();
  });

  it('résolution avec strict:false (le service vit dans un autre conteneur)', async () => {
    const h = harness();
    await h.service.register(clientPayload({ referralCode: 'RELIO-ABCDE' }));
    expect(h.get).toHaveBeenCalledWith(ReferralsService, { strict: false });
  });

  it('CLIENT sans code → aucun appel au parrainage', async () => {
    const h = harness();
    await expect(h.service.register(clientPayload())).resolves.toBeDefined();
    expect(h.get).not.toHaveBeenCalled();
    expect(h.referralsService.registerReferral).not.toHaveBeenCalled();
  });

  it('code en espace ou vide → aucun appel (rien à signaler)', async () => {
    const h = harness();
    await h.service.register(clientPayload({ referralCode: '   ' }));
    expect(h.referralsService.registerReferral).not.toHaveBeenCalled();
  });

  it('TECHNICIAN avec code → NON rattaché (pas de programme pour un technicien)', async () => {
    const h = harness();
    await h.service.register({
      ...clientPayload({ referralCode: 'RELIO-ABCDE' }),
      role: 'TECHNICIAN',
      phone: '+237690000000',
      categories: ['plomberie'],
      cityId: DOUALA_ID,
    } as never);

    /* Rattacher un technicien consommerait un emplacement du parrain sans
     * jamais donner lieu à une récompense. */
    expect(h.referralsService.registerReferral).not.toHaveBeenCalled();
  });

  it('code INCONNU → inscription réussie, aucun échec', async () => {
    const h = harness({
      referrals: {
        registerReferral: vi.fn(async () => {
          throw new Error('Code de parrainage inconnu');
        }),
      } as never,
    });

    await expect(
      h.service.register(clientPayload({ referralCode: 'RELIO-ZZZZZ' })),
    ).resolves.toBeDefined();
    expect(h.createdUsers).toHaveLength(1);
  });

  it('code DÉJÀ UTILISÉ (auto-parrainage) → inscription réussie', async () => {
    const h = harness({
      referrals: {
        registerReferral: vi.fn(async () => {
          throw new Error('Ce compte est déjà rattaché à un parrain');
        }),
      } as never,
    });

    await expect(
      h.service.register(clientPayload({ referralCode: 'RELIO-ABCDE' })),
    ).resolves.toBeDefined();
    expect(h.createdUsers).toHaveLength(1);
  });

  it('limite de 5 atteinte → inscription réussie', async () => {
    /* Le service ne lève pas pour une limite atteinte : c'est vérifié dans
     * `referrals.service.spec.ts`. Ici on vérifie que même s'il levait, le
     * compte resterait créé. */
    const h = harness({
      referrals: {
        registerReferral: vi.fn(async () => {
          throw new Error('Limite de parrainage atteinte');
        }),
      } as never,
    });
    await expect(
      h.service.register(clientPayload({ referralCode: 'RELIO-ABCDE' })),
    ).resolves.toBeDefined();
  });

  it('ReferralsModule NON monté → inscription réussie', async () => {
    /* Assemblage partiel, ou `ReferralsService` absent du conteneur : la
     * résolution doit échouer SANS Lever. */
    const h = harness({ moduleRefThrows: true });
    await expect(
      h.service.register(clientPayload({ referralCode: 'RELIO-ABCDE' })),
    ).resolves.toBeDefined();
    expect(h.createdUsers).toHaveLength(1);
  });

  it('service résolu à null → inscription réussie', async () => {
    const h = harness({ referrals: null });
    await expect(
      h.service.register(clientPayload({ referralCode: 'RELIO-ABCDE' })),
    ).resolves.toBeDefined();
  });

  it('le e-mail de vérification part malgré un code de parrainage invalide', async () => {
    /* L'inscription reste complète : le parcours ne perd pas une étape. */
    const h = harness({
      referrals: {
        registerReferral: vi.fn(async () => {
          throw new Error('inconnu');
        }),
      } as never,
    });
    await h.service.register(
      clientPayload({ referralCode: 'Bidon', emailVerification: true }),
    );
    expect(h.email.sendVerificationEmail).toHaveBeenCalled();
  });
});
