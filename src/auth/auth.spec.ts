import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { JwtAuthGuard } from './jwt-auth.guard.js';
import { RolesGuard } from './roles.guard.js';
import { AdminController } from '../admin/admin.controller.js';
import { DemandesController } from '../demandes/demandes.controller.js';
import { CollaborationController } from '../collaboration/collaboration.controller.js';
import { hashPassword } from './password-hash.js';

/* Correctif post-audit — couverture Auth (aucune spec auparavant) :
 * inscription/connexion/JWT-cookie/vérification/guards/rôles, avec Prisma
 * simulé. Comportement métier inchangé, uniquement vérifié. */

type Row = Record<string, any>;

const BASE_USER: Row = {
  id: 'u-1',
  role: 'CLIENT',
  firstName: 'Awa',
  lastName: null,
  phone: null,
  email: 'awa@example.com',
  emailVerified: true,
  avatarUrl: null,
  city: 'Douala',
  address: null,
  whatsapp: null,
  createdAt: new Date(),
  isActive: true,
  tokenVersion: 0,
};

function configMock() {
  const values: Record<string, string> = {
    NODE_ENV: 'test',
    JWT_SECRET: 'test-secret-xyz',
    JWT_EXPIRES_IN: '7d',
    FRONTEND_URL: 'https://test.local',
  };
  return { get: vi.fn((key: string) => values[key]) } as never;
}

function authService(users: Row[] = [], passwordHash?: string) {
  const store = new Map(users.map((u) => [u.id, { ...u }]));
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return store.get(where.id) ? { ...store.get(where.id) } : null;
        if (where.email) {
          for (const u of store.values()) {
            if (u.email === where.email) return { ...u };
          }
        }
        return null;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        for (const u of store.values()) {
          if (where.emailVerificationToken !== undefined && u.emailVerificationToken === where.emailVerificationToken) {
            return { ...u };
          }
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `u-${store.size + 1}`, emailVerified: false, isActive: true, createdAt: new Date(), ...data };
        store.set(row.id, row);
        return { ...row };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = store.get(where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data);
        return { ...row };
      }),
    },
    serviceCity: { findMany: vi.fn(async () => []) },
    zone: { findMany: vi.fn(async () => []) },
    $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
      callback({ user: prisma.user }),
    ),
  };
  const email = { sendVerificationEmail: vi.fn(async () => undefined) };
  const service = new AuthService(prisma as never, configMock(), email as never, {} as never);
  if (passwordHash) {
    for (const row of store.values()) {
      row.passwordHash = passwordHash;
    }
  }
  return { service, prisma, email, store };
}

function contextWith(user?: Row) {
  return {
    switchToHttp: () => ({ getRequest: () => (user ? { user, cookies: {} } : { cookies: {} }) }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as never;
}

describe('register — validation métier', () => {
  it('client minimal → créé, e-mail de vérification envoyé', async () => {
    const { service, email } = authService();
    const result = await service.register({
      role: 'CLIENT',
      firstName: 'Awa',
      lastName: 'Diallo',
      email: 'awa@example.com',
      password: 'S3cret!pass',
      city: 'Douala',
      address: 'Rue 123',
    } as never);
    expect(result.email).toBe('awa@example.com');
    expect(email.sendVerificationEmail).toHaveBeenCalledTimes(1);
  });

  it('email déjà pris (P2002) → 409', async () => {
    const { service } = authService();
    (service as any).prisma.user.create = vi.fn(async () => {
      throw Object.assign(new Error('Unique'), { code: 'P2002' });
    });
    await expect(
      service.register({ role: 'CLIENT', firstName: 'A', lastName: 'B', email: 'a@x.y', password: 'S3cret!pass', city: 'D', address: 'R' } as never),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('technicien sans téléphone/ville/catégories → 400', async () => {
    const { service } = authService();
    await expect(
      service.register({ role: 'TECHNICIAN', firstName: 'T', email: 't@x.y', password: 'S3cret!pass' } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('mot de passe faible → 400 (règle alignée sur reset-password)', async () => {
    const { service } = authService();
    await expect(
      service.register({ role: 'CLIENT', firstName: 'A', lastName: 'B', email: 'a@x.y', password: 'faible12', city: 'D', address: 'R' } as never),
    ).rejects.toMatchObject({
      status: 400,
      message:
        'Le mot de passe doit contenir au moins 8 caractères, 1 majuscule, 1 minuscule et 1 chiffre.',
    });
  });
});

/* Chantier D2.5 — le cookie de session est posé SYSTÉMATIQUEMENT à
 * l'inscription, y compris pour un CLIENT dont l'e-mail n'est pas vérifié.
 *
 * C'est ce qui débloque le tunnel public « demande d'abord, inscription à la
 * fin » : sans cookie, `POST /demandes/drafts/:token/convert` répondait 401
 * et la demande ne pouvait jamais partir.
 *
 * La vérification d'e-mail reste obligatoire pour ACCÉDER au dashboard, mais
 * elle est appliquée côté frontend (`guard-decision.ts`), pas par l'absence de
 * cookie. Les deux contrôles sont distincts. */
describe('register (controller) — cookie systématique', () => {
  function registerWith(emailVerified: boolean) {
    const user = { ...BASE_USER, emailVerified };
    const service = {
      register: vi.fn(async () => user),
      verifyEmail: vi.fn(async () => ({ ...user, emailVerified: true })),
      signToken: vi.fn(() => 'jwt.signe.test'),
      setAuthCookie: vi.fn(),
      clearAuthCookie: vi.fn(),
    } as unknown as AuthService;
    const controller = new AuthController(service);
    const res = { cookie: vi.fn(), clearCookie: vi.fn() } as never;
    return { controller, service, res, user };
  }

  it('CLIENT non vérifié : le cookie est QUAND MÊME posé', async () => {
    const { controller, service, res, user } = registerWith(false);
    await controller.register({} as never, res);
    expect(service.setAuthCookie).toHaveBeenCalledTimes(1);
    /* La preuve du bug corrigé : le conditionnel `if (user.emailVerified)`
     * делаait échouer cette assertion. */
    expect(user.emailVerified).toBe(false);
  });

  it('TECHNICIAN vérifié : le cookie est posé aussi', async () => {
    const { controller, service, res } = registerWith(true);
    await controller.register({} as never, res);
    expect(service.setAuthCookie).toHaveBeenCalledTimes(1);
  });

  it("le token provient de AuthService (JWT signé, pas opaque)", async () => {
    const { controller, service, res } = registerWith(false);
    await controller.register({} as never, res);
    expect(service.signToken).toHaveBeenCalledTimes(1);
    expect(service.setAuthCookie).toHaveBeenCalledWith(res, 'jwt.signe.test');
  });

  it('verify-email pose toujours le cookie', async () => {
    const { controller, service, res } = registerWith(true);
    await controller.verifyEmail({ token: 't' } as never, res);
    expect(service.setAuthCookie).toHaveBeenCalledTimes(1);
  });

  it('la réponse reste { user, mode } et ne divulgue aucun hash', async () => {
    const { controller, res } = registerWith(false);
    const body = await controller.register({} as never, res);
    expect(body).toHaveProperty('user');
    expect(body).toHaveProperty('mode', 'real');
    expect(body.user.passwordHash).toBeUndefined();
  });
});

describe('login — identifiants, état du compte, vérification', () => {
  it('email inconnu → 401 sans détail', async () => {
    const { service } = authService([]);
    await expect(service.login({ email: 'nobody@x.y', password: 'x' } as never)).rejects.toMatchObject({
      status: 401,
      message: 'Identifiants invalides.',
    });
  });

  it('mauvais mot de passe → 401', async () => {
    const hash = await hashPassword('bon-mot-de-passe');
    const { service } = authService([{ ...BASE_USER, passwordHash: 'x' }], hash);
    await expect(service.login({ email: 'awa@example.com', password: 'mauvais' } as never)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('bon mot de passe → AuthUser sans hash', async () => {
    const hash = await hashPassword('bon-mot-de-passe');
    const { service } = authService([{ ...BASE_USER, passwordHash: 'x' }], hash);
    const result = await service.login({ email: 'awa@example.com', password: 'bon-mot-de-passe' } as never);
    expect(result.id).toBe('u-1');
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('compte désactivé → 403 (avant même le mot de passe)', async () => {
    const { service } = authService([{ ...BASE_USER, isActive: false, passwordHash: 'x' }]);
    await expect(service.login({ email: 'awa@example.com', password: 'nimporte' } as never)).rejects.toMatchObject({
      status: 403,
    });
  });

  it('client non vérifié → 401 ; technicien non vérifié → OK', async () => {
    const hash = await hashPassword('secret123');
    const unverified = { ...BASE_USER, emailVerified: false };
    const { service } = authService([unverified], hash);
    await expect(service.login({ email: 'awa@example.com', password: 'secret123' } as never)).rejects.toMatchObject({
      status: 401,
    });
    const tech = authService([{ ...unverified, id: 't-1', role: 'TECHNICIAN' }], hash);
    const result = await tech.service.login({ email: 'awa@example.com', password: 'secret123' } as never);
    expect(result.role).toBe('TECHNICIAN');
  });
});

describe('verifyEmail / resend — sans oracle', () => {
  /* Chantier FIX — le contrat a changé : le token n'est PLUS remis à `null`,
   * et un rejeu sur un compte déjà vérifié est un SUCCÈS idempotent, pas un
   * 400. Le motif est détaillé dans `AuthService.verifyEmail`. */
  it('token valide → vérifié', async () => {
    const { service } = authService([
      { ...BASE_USER, emailVerified: false, emailVerificationToken: 'tok-1', emailVerificationExpiresAt: new Date(Date.now() + 3600_000) },
    ]);
    const { user, alreadyVerified } = await service.verifyEmail('tok-1');
    expect(user.emailVerified).toBe(true);
    expect(alreadyVerified).toBe(false);
  });

  it('rejeu d’un token DÉJÀ VÉRIFIÉ → succès idempotent (plus un 400 trompeur)', async () => {
    /* C'est le bug corrigé : le token étant mis à `null`, un rejeu ne
     * trouvait aucun compte et renvoyait « lien invalide ou expiré », alors que
     * tout allait bien. Le token reste donc une clé de recherche. */
    const { service } = authService([
      { ...BASE_USER, emailVerified: true, emailVerificationToken: 'tok-2', emailVerificationExpiresAt: new Date(Date.now() + 3600_000) },
    ]);
    const { user, alreadyVerified } = await service.verifyEmail('tok-2');
    expect(alreadyVerified).toBe(true);
    expect(user.emailVerified).toBe(true);
  });

  it('rejeu tardif : token expiré MAIS compte déjà vérifié → déjà vérifié', async () => {
    /* Le cas le plus fréquent en pratique : on reclique le lien plusieurs jours
     * après. Tester l'expiration AVANT « déjà vérifié » renverrait vers le
     * message trompeur — l'ordre des vérifications compte. */
    const { service } = authService([
      { ...BASE_USER, emailVerified: true, emailVerificationToken: 'tok-3', emailVerificationExpiresAt: new Date(Date.now() - 1000) },
    ]);
    const { alreadyVerified } = await service.verifyEmail('tok-3');
    expect(alreadyVerified).toBe(true);
  });

  it('token expiré / inconnu → 400', async () => {
    const { service } = authService([
      { ...BASE_USER, emailVerified: false, emailVerificationToken: 'tok-old', emailVerificationExpiresAt: new Date(Date.now() - 1000) },
    ]);
    await expect(service.verifyEmail('tok-old')).rejects.toMatchObject({ status: 400 });
    await expect(service.verifyEmail('tok-unknown')).rejects.toMatchObject({ status: 400 });
  });

  it('la vérification n’efface PAS le token (sinon le rejeu ne trouve plus rien)', async () => {
    /* L'invariant central du correctif. Le token n'est PAS réécrit : il garde
     * sa valeur en base, ce qui le rend à nouveau trouvable au rejeu. Écrire
     * `emailVerificationToken: null` ici — l'ancien comportement — ferait
     * repasser le test « déjà vérifié » en échec et renverrait l'utilisateur au
     * message d'erreur trompeur. */
    const { service } = authService([
      { ...BASE_USER, emailVerified: false, emailVerificationToken: 'tok-keep', emailVerificationExpiresAt: new Date(Date.now() + 3600_000) },
    ]);
    const update = vi.fn(async () => ({ ...BASE_USER, emailVerified: true }));
    (service as any).prisma.user.update = update;
    await service.verifyEmail('tok-keep');
    const data = update.mock.calls[0][0].data;
    expect(data.emailVerified).toBe(true);
    expect(data.emailVerificationToken).toBeUndefined();
    expect(data.emailVerificationExpiresAt).toBeUndefined();
  });

  it('resend → toujours { ok:true }, envoi seul si client non vérifié', async () => {
    const { service, email } = authService([{ ...BASE_USER, emailVerified: false }]);
    expect(await service.resendVerification('awa@example.com')).toEqual({ ok: true });
    expect(email.sendVerificationEmail).toHaveBeenCalledTimes(1);
    const unknown = authService([]);
    expect(await unknown.service.resendVerification('nobody@x.y')).toEqual({ ok: true });
    expect(unknown.email.sendVerificationEmail).not.toHaveBeenCalled();
  });
});

describe('JWT + cookie — session', () => {
  it('signToken → verifyToken roundtrip', async () => {
    const { service } = authService([{ ...BASE_USER }]);
    const token = service.signToken({ ...BASE_USER, role: 'CLIENT' } as never);
    const payload = await service.verifyToken(token);
    expect(payload).toMatchObject({ id: 'u-1', role: 'CLIENT' });
  });

  it('token falsifié / sub inconnu / compte désactivé → 401', async () => {
    const { service } = authService([{ ...BASE_USER }]);
    await expect(service.verifyToken('falsifié')).rejects.toMatchObject({ status: 401 });
    const others = authService([]);
    const token = service.signToken({ ...BASE_USER, role: 'CLIENT' } as never);
    await expect(others.service.verifyToken(token)).rejects.toMatchObject({ status: 401 });
    const inactive = authService([{ ...BASE_USER, isActive: false }]);
    await expect(inactive.service.verifyToken(token)).rejects.toMatchObject({ status: 401 });
  });

  it('setAuthCookie : httpOnly + lax hors prod ; clearAuthCookie', () => {
    const { service } = authService();
    const cookie = vi.fn();
    service.setAuthCookie({ cookie } as never, 'tok');
    expect(cookie).toHaveBeenCalledWith('repairdom_token', 'tok', expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }));
    const clear = vi.fn();
    service.clearAuthCookie({ clearCookie: clear } as never);
    expect(clear).toHaveBeenCalled();
  });
});

describe('guards — JwtAuthGuard + RolesGuard', () => {
  it('sans cookie → 401 ; token valide → request.user posé', async () => {
    const { service } = authService([{ ...BASE_USER }]);
    const guard = new JwtAuthGuard(service);
    await expect(guard.canActivate(contextWith() as never)).rejects.toMatchObject({ status: 401 });
    const token = service.signToken({ ...BASE_USER, role: 'CLIENT' } as never);
    const context = { switchToHttp: () => ({ getRequest: () => ({ cookies: { repairdom_token: token } }) }) } as never;
    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('RolesGuard : sans rôles → true ; rôle OK → true ; sinon 403 ; sans user → 403', () => {
    const reflector = { getAllAndOverride: vi.fn() } as unknown as Reflector;
    const guard = new RolesGuard(reflector);
    (reflector.getAllAndOverride as any).mockReturnValue(undefined);
    expect(guard.canActivate(contextWith({ id: 'x', role: 'CLIENT' }))).toBe(true);
    (reflector.getAllAndOverride as any).mockReturnValue(['ADMIN']);
    expect(guard.canActivate(contextWith({ id: 'x', role: 'ADMIN' }))).toBe(true);
    expect(() => guard.canActivate(contextWith({ id: 'x', role: 'CLIENT' }))).toThrow(
      expect.objectContaining({ status: 403 }),
    );
    expect(() => guard.canActivate(contextWith())).toThrow(expect.objectContaining({ status: 403 }));
  });

  it('rôles par contrôleur : CLIENT / ADMIN / CLIENT+TECHNICIAN', () => {
    expect(Reflect.getMetadata('roles', DemandesController)).toEqual(['CLIENT']);
    expect(Reflect.getMetadata('roles', AdminController)).toEqual(['ADMIN']);
    expect(Reflect.getMetadata('roles', CollaborationController)).toEqual(
      expect.arrayContaining(['CLIENT', 'TECHNICIAN']),
    );
    const proto = AuthController.prototype as unknown as Record<string, unknown>;
    for (const handler of ['register', 'login', 'verifyEmail', 'resendVerification', 'me', 'logout']) {
      expect(typeof proto[handler]).toBe('function');
    }
  });
});
