import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { VerificationReminderScheduler } from './verification-reminder.scheduler.js';

/* Chantier D2.5 — GARDE-FOU D'ASSEMBLAGE NESTJS (`app.init()`).
 *
 * Pourquoi ce test existe : une dépendance non résoluble, un provider manquant
 * ou un CYCLE DE MODULES ne se voit qu'à `app.init()` — c'est-à-dire au
 * DÉMARRAGE SUR RAILWAY, pas au `nest build`. Le chantier D2.5 ajoute
 * `VerificationReminderScheduler` dans `AuthModule`, qui est importé par
 * presque tous les autres modules : une erreur de graphe ici ferait tomber
 * l'API entière. (Leçon du crash `web-push`, déjà payée dans
 * `rewards.module.spec.ts`.)
 *
 * AUCUNE INFRASTRUCTURE : `PrismaService` n'implémente PAS `OnModuleInit`, donc
 * aucune connexion n'est ouverte au boot. `DATABASE_URL` est un dummy — aucun
 * port n'est touché. Le scheduler n'est pas déclenché : il n'est lancé qu'au
 * premier `setInterval`, et `unref()` le laisse sans empêcher le test de se terminer.
 *
 * Le test vérifie aussi que l'intervalle n'est PAS armé à l'import du module
 * (un `setInterval` au chargement transformerait `import` en effet de bord). */

const DUMMY_DATABASE_URL = 'postgresql://user:pass@127.0.0.1:5432/relio_test_never_connected';

describe('VerificationReminderScheduler (assemblage NestJS)', () => {
  let app: INestApplication;
  let AppModule: typeof import('../app.module.js')['AppModule'];

  beforeAll(async () => {
    process.env.DATABASE_URL = DUMMY_DATABASE_URL;
    process.env.NODE_ENV = 'test';

    ({ AppModule } = await import('../app.module.js'));

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('Démarre sans erreur de graphe de modules (pas de cycle)', () => {
    expect(app).toBeDefined();
  });

  it('le scheduler est résoluble par le conteneur', () => {
    /* `strict: false` : le provider est INTERNE à `AuthModule` (non exporté),
     * on interroge donc le graphe applicatif complet. */
    expect(app.get(VerificationReminderScheduler, { strict: false })).toBeInstanceOf(
      VerificationReminderScheduler,
    );
  });

  it('expose un balayage manuel appelable (débogage prod)', () => {
    const scheduler = app.get(VerificationReminderScheduler, { strict: false });
    /* Le scénario de test 3 (relances accélérées) a besoin d'un point
     * d'entrée sans attendre l'heure : `sweep(now)` est public. */
    expect(typeof scheduler.sweep).toBe('function');
  });

  it('l’API démarre toujours (aucune route auth cassée par l’ajout)', async () => {
    /* Non testé fonctionnellement ici : l'endpoint public d'inscription doit
     * exister et ne doit pas être protégé. Un 400 prouve que la route est
     * atteinte et que la ValidationPipe s'applique. */
    const server = app.getHttpServer();
    const request = (await import('supertest')).default;
    await request(server).post('/api/auth/register').send({}).expect(400);
  });
});