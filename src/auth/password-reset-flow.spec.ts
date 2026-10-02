import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { AuthModule } from './auth.module.js';
import { PrismaModule } from '../prisma/prisma.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { EmailService } from './email.service.js';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SupabaseStorageService } from '../technician/supabase-storage.service.js';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter.js';

/* DEBUG — scénario « login → reset → login → dashboard » en HTTP réel
 * (vraie app Nest : routing, ValidationPipe, JwtAuthGuard, cookies).
 * Seul Prisma est simulé (aucune base disponible ici), avec une sémantique
 * fidèle (dont `tokenVersion: { increment: 1 }`).
 *
 * Attendu : reconnexion OK (me → 200, tokenVersion 1), ancien cookie → 401.
 * Si ce test est vert et le manuel échoue, la cause est hors code
 * (migration non appliquée / client Prisma non régénéré côté déploiement). */

type Row = Record<string, any>;

const store = new Map<string, Row>();
const attempts: Row[] = [];

function applyUpdate(row: Row, data: Record<string, any>) {
  for (const [key, value] of Object.entries(data)) {
    row[key] =
      value && typeof value === 'object' && 'increment' in value
        ? (row[key] ?? 0) + (value as { increment: number }).increment
        : value;
  }
}

const fakePrisma = {
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
        const keys = Object.keys(where);
        if (keys.every((k) => u[k] === (where as Row)[k])) return { ...u };
      }
      return null;
    }),
    create: vi.fn(async ({ data }: any) => {
      for (const u of store.values()) {
        if (u.email === data.email) throw Object.assign(new Error('Unique'), { code: 'P2002' });
      }
      const row = {
        id: `u-${store.size + 1}`,
        role: 'CLIENT',
        lastName: null,
        phone: null,
        whatsapp: null,
        city: null,
        cityId: null,
        address: null,
        avatarUrl: null,
        emailVerified: false,
        emailVerificationToken: null,
        emailVerificationExpiresAt: null,
        passwordResetToken: null,
        passwordResetExpiresAt: null,
        tokenVersion: 0,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...data,
      };
      store.set(row.id, row);
      return { ...row };
    }),
    update: vi.fn(async ({ where, data }: any) => {
      const row = store.get(where.id);
      if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
      applyUpdate(row, data);
      return { ...row };
    }),
  },
  technicianProfile: { create: vi.fn(async ({ data }: any) => ({ id: 'tp-1', ...data })) },
  serviceCity: { findMany: vi.fn(async () => []) },
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
  $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({ user: fakePrisma.user, technicianProfile: fakePrisma.technicianProfile }),
  ),
};

const configValues: Record<string, string> = {
  NODE_ENV: 'test',
  JWT_SECRET: 'flow-test-secret',
  JWT_EXPIRES_IN: '7d',
  FRONTEND_URL: 'https://test.local',
};

function cookieValue(setCookie: string | string[] | undefined, name: string): string | null {
  const headers = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  const found = headers.find((h) => h.startsWith(`${name}=`));
  if (!found) return null;
  return found.slice(name.length + 1).split(';')[0] ?? null;
}

describe('flow HTTP : login → reset → login → dashboard', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, AuthModule],
    })
      .overrideProvider(ConfigService)
      .useValue({ get: (key: string) => configValues[key] })
      .overrideProvider(PrismaService)
      .useValue(fakePrisma)
      .overrideProvider(EmailService)
      .useValue({ sendVerificationEmail: async () => undefined, sendPasswordResetEmail: async () => undefined })
      .overrideProvider(SupabaseStorageService)
      .useValue({})
      .compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    app.useGlobalFilters(new HttpExceptionFilter());
    app.use(cookieParser());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('reconnexion post-reset : me → 200 (v1), ancien cookie → 401', async () => {
    const server = app.getHttpServer();
    const agent = request.agent(server);

    // 1. Inscription technicien (vérifié d'office → session immédiate).
    const registered = await agent
      .post('/api/auth/register')
      .send({
        firstName: 'Tech',
        lastName: 'Nicien',
        phone: '690000000',
        email: 'tech@example.com',
        password: 'OldPass123',
        role: 'TECHNICIAN',
        city: 'Douala',
        categories: ['plomberie'],
      })
      .expect(201);
    // H1 : le JWT posé au register porte tokenVersion = 0.
    expect(
      (jwt.decode(cookieValue(registered.headers['set-cookie'], 'repairdom_token') ?? '') as {
        tokenVersion?: unknown;
      } | null)?.tokenVersion,
    ).toBe(0);

    // 2. Dashboard accessible : me → 200, JWT v0.
    const me1 = await agent.get('/api/auth/me').expect(200);
    expect(me1.body.email).toBe('tech@example.com');

    // 3. Reset : demande → token → reset.
    await agent.post('/api/auth/forgot-password').send({ email: 'tech@example.com' }).expect(200);
    const row = [...store.values()].find((u) => u.email === 'tech@example.com');
    expect(typeof row?.passwordResetToken).toBe('string');
    const token = row?.passwordResetToken as string;
    await agent.get(`/api/auth/reset-password/${token}/validate`).expect(200, { valid: true });
    await agent
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'NewPass123' })
      .expect(200);

    // 4. Ancien cookie (v0) → 401 + cookie effacé.
    const stale = await agent.get('/api/auth/me').expect(401);
    expect(cookieValue(stale.headers['set-cookie'], 'repairdom_token')).toBe('');

    // 5. Reconnexion nouveau mot de passe → me → 200, JWT v1.
    const fresh = request.agent(server);
    const login = await fresh
      .post('/api/auth/login')
      .send({ email: 'tech@example.com', password: 'NewPass123' })
      .expect(200);
    // H1 : le JWT posé au login post-reset porte tokenVersion = 1.
    expect(
      (jwt.decode(cookieValue(login.headers['set-cookie'], 'repairdom_token') ?? '') as {
        tokenVersion?: unknown;
      } | null)?.tokenVersion,
    ).toBe(1);
    const me2 = await fresh.get('/api/auth/me').expect(200);
    expect(me2.body.email).toBe('tech@example.com');

    // 6. Ancien mot de passe refusé.
    await request(server)
      .post('/api/auth/login')
      .send({ email: 'tech@example.com', password: 'OldPass123' })
      .expect(401);
  });

  it('variante CLIENT (compte vérifié) : reset → reconnexion → me 200', async () => {
    const server = app.getHttpServer();
    const agent = request.agent(server);

    // Inscription client → vérification e-mail → session.
    await agent
      .post('/api/auth/register')
      .send({
        firstName: 'Awa',
        lastName: 'Diallo',
        email: 'awa@example.com',
        password: 'OldPass123',
        role: 'CLIENT',
        city: 'Douala',
        address: 'Rue 123',
      })
      .expect(201);
    const created = [...store.values()].find((u) => u.email === 'awa@example.com');
    await agent
      .post('/api/auth/verify-email')
      .send({ token: created?.emailVerificationToken })
      .expect(200);
    await agent.get('/api/auth/me').expect(200);

    // Reset complet puis reconnexion.
    await agent.post('/api/auth/forgot-password').send({ email: 'awa@example.com' }).expect(200);
    const withToken = [...store.values()].find((u) => u.email === 'awa@example.com');
    const token = withToken?.passwordResetToken as string;
    await agent.get(`/api/auth/reset-password/${token}/validate`).expect(200, { valid: true });
    const done = await agent
      .post('/api/auth/reset-password')
      .send({ token, newPassword: 'NewPass123' })
      .expect(200);
    expect(done.body).toMatchObject({ ok: true, role: 'CLIENT' });

    // Ancien cookie → 401 ; reconnexion → me → 200 avec la bonne version.
    await agent.get('/api/auth/me').expect(401);
    const fresh = request.agent(server);
    const login = await fresh
      .post('/api/auth/login')
      .send({ email: 'awa@example.com', password: 'NewPass123' })
      .expect(200);
    // Cookie de session posé à la reconnexion.
    expect(cookieValue(login.headers['set-cookie'], 'repairdom_token')).not.toBeNull();
    const me = await fresh.get('/api/auth/me').expect(200);
    expect(me.body).toMatchObject({ email: 'awa@example.com', role: 'CLIENT' });
  });
});
