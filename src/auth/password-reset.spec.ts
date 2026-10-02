import { describe, expect, it, vi } from 'vitest';
import { AuthService } from './auth.service.js';
import { hashPassword } from './password-hash.js';

/* Reset password — token à usage unique, anti-énumération, invalidation des
 * sessions (tokenVersion), rate-limiting en base. Prisma simulé. */

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
  passwordResetToken: null,
  passwordResetExpiresAt: null,
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

function setup(users: Row[] = []) {
  const store = new Map(users.map((u) => [u.id, { ...u }]));
  const attempts: Row[] = [];
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
          if (
            where.passwordResetToken !== undefined &&
            u.passwordResetToken === where.passwordResetToken
          ) {
            return { ...u };
          }
        }
        return null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = store.get(where.id);
        if (!row) throw new Error('not found');
        for (const [key, value] of Object.entries(data as Record<string, any>)) {
          row[key] =
            value && typeof value === 'object' && 'increment' in value
              ? (row[key] ?? 0) + (value as { increment: number }).increment
              : value;
        }
        return { ...row };
      }),
    },
    passwordResetAttempt: {
      deleteMany: vi.fn(async ({ where }: any) => {
        const lt = where.createdAt?.lt as Date | undefined;
        let count = 0;
        for (let i = attempts.length - 1; i >= 0; i -= 1) {
          if (lt && attempts[i].createdAt < lt) {
            attempts.splice(i, 1);
            count += 1;
          }
        }
        return { count };
      }),
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `a-${attempts.length + 1}`, createdAt: new Date(), ...data };
        attempts.push(row);
        return row;
      }),
      count: vi.fn(async ({ where }: any) => {
        const since = where.createdAt?.gte as Date | undefined;
        return attempts.filter(
          (a) =>
            (!where.email || a.email === where.email) &&
            (!where.ip || a.ip === where.ip) &&
            (!since || a.createdAt >= since),
        ).length;
      }),
    },
  };
  const email = { sendPasswordResetEmail: vi.fn(async () => undefined) };
  const service = new AuthService(prisma as never, configMock(), email as never, {} as never);
  return { service, prisma, email, store, attempts };
}

describe('requestPasswordReset', () => {
  it('email existant → token créé, e-mail envoyé, 200', async () => {
    const { service, email, store } = setup([{ ...BASE_USER }]);
    const result = await service.requestPasswordReset('awa@example.com', '1.2.3.4');
    expect(result).toEqual({ ok: true });
    const row = store.get('u-1') as Row;
    expect(typeof row.passwordResetToken).toBe('string');
    expect((row.passwordResetToken as string).length).toBeGreaterThan(32);
    expect((row.passwordResetExpiresAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(email.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    expect((email.sendPasswordResetEmail.mock.calls[0] as unknown[])[0]).toBe('awa@example.com');
  });

  it('email inexistant → 200 identique, aucun token, aucun e-mail', async () => {
    const { service, email, prisma } = setup([]);
    const result = await service.requestPasswordReset('inconnu@example.com', '1.2.3.4');
    expect(result).toEqual({ ok: true });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(email.sendPasswordResetEmail).not.toHaveBeenCalled();
  });

  it('4e demande en <1h pour le même e-mail → 429', async () => {    const { service } = setup([{ ...BASE_USER }]);
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      await service.requestPasswordReset('awa@example.com', `9.9.9.${i}`);
      expect(Date.now() - now).toBeLessThan(60 * 60 * 1000);
    }
    await expect(service.requestPasswordReset('awa@example.com', '9.9.9.9')).rejects.toMatchObject({
      status: 429,
    });
  });

  it('cleanup opportuniste : 5 tentatives >24h purgées, 2 récentes conservées', async () => {
    const { service, prisma } = setup([{ ...BASE_USER }]);
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    for (let i = 0; i < 5; i += 1) {
      await prisma.passwordResetAttempt.create({
        data: { email: 'awa@example.com', ip: '1.1.1.1', createdAt: old },
      });
    }
    for (let i = 0; i < 2; i += 1) {
      await prisma.passwordResetAttempt.create({
        data: { email: 'awa@example.com', ip: '1.1.1.1', createdAt: new Date() },
      });
    }
    await service.requestPasswordReset('awa@example.com', '2.2.2.2');
    const remaining = await prisma.passwordResetAttempt.count({
      where: { email: 'awa@example.com' },
    });
    // 2 récentes + 1 créée par l'appel, 0 ancienne.
    expect(remaining).toBe(3);
  });
});

describe('resetPassword', () => {
  it('token valide → mot de passe changé, token effacé, tokenVersion incrémentée', async () => {
    const oldHash = await hashPassword('OldPass123');
    const { service, store } = setup([
      {
        ...BASE_USER,
        passwordHash: oldHash,
        passwordResetToken: 'tok-valide',
        passwordResetExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    ]);
    const result = await service.resetPassword('tok-valide', 'NewPass123');
    expect(result).toEqual({ ok: true, role: 'CLIENT' });
    const row = store.get('u-1') as Row;
    expect(row.passwordResetToken).toBeNull();
    expect(row.passwordResetExpiresAt).toBeNull();
    expect(row.tokenVersion).toBe(1);
    expect(row.passwordHash).not.toBe(oldHash);
  });

  it('token expiré → 400', async () => {
    const { service } = setup([
      {
        ...BASE_USER,
        passwordResetToken: 'tok-expire',
        passwordResetExpiresAt: new Date(Date.now() - 1000),
      },
    ]);
    await expect(service.resetPassword('tok-expire', 'NewPass123')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('token déjà utilisé (effacé) → 400', async () => {
    const { service } = setup([{ ...BASE_USER }]);
    await expect(service.resetPassword('tok-consomme', 'NewPass123')).rejects.toMatchObject({
      status: 400,
    });
  });

  it('mot de passe faible → 400 avec message clair', async () => {
    const { service } = setup([
      {
        ...BASE_USER,
        passwordResetToken: 'tok-valide',
        passwordResetExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    ]);
    await expect(service.resetPassword('tok-valide', 'faible')).rejects.toMatchObject({
      status: 400,
      message:
        'Le mot de passe doit contenir au moins 8 caractères, 1 majuscule, 1 minuscule et 1 chiffre.',
    });
    await expect(service.resetPassword('tok-valide', 'sansmajuscule1')).rejects.toMatchObject({
      status: 400,
    });
    await expect(service.resetPassword('tok-valide', 'SANSCHIFFRE')).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('validateResetToken + invalidation JWT', () => {
  it('token valide → { valid: true }, expiré → { valid: false }', async () => {
    const { service } = setup([
      {
        ...BASE_USER,
        passwordResetToken: 'tok-ok',
        passwordResetExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
      {
        ...BASE_USER,
        id: 'u-2',
        email: 'b@example.com',
        passwordResetToken: 'tok-ko',
        passwordResetExpiresAt: new Date(Date.now() - 1000),
      },
    ]);
    expect(await service.validateResetToken('tok-ok')).toEqual({ valid: true });
    expect(await service.validateResetToken('tok-ko')).toEqual({ valid: false });
    expect(await service.validateResetToken('tok-inconnu')).toEqual({ valid: false });
  });

  it('ancien JWT rejeté après reset (tokenVersion différente) → 401', async () => {
    const { service } = setup([
      {
        ...BASE_USER,
        passwordHash: await hashPassword('OldPass123'),
        passwordResetToken: 'tok-valide',
        passwordResetExpiresAt: new Date(Date.now() + 30 * 60 * 1000),
      },
    ]);
    const before = await service.me('u-1');
    const oldJwt = service.signToken({ ...before, tokenVersion: 0 });
    await service.resetPassword('tok-valide', 'NewPass123');
    await expect(service.verifyToken(oldJwt)).rejects.toMatchObject({ status: 401 });
    const after = await service.me('u-1');
    const freshJwt = service.signToken({ ...after, tokenVersion: 1 });
    const checked = await service.verifyToken(freshJwt);
    expect(checked.id).toBe('u-1');
  });
});
