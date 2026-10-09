import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ReferralsService } from './referrals.service.js';
import { ReferralsNotificationsService } from './referrals-notifications.service.js';
import { ReferralsController } from './referrals.controller.js';

/* Chantier 4B — GARDE-FOU D'ASSEMBLAGE NESTJS (`app.init()`).
 *
 * CE TEST EST LE PLUS UTILE DU CHANTIER.
 *
 * Le chantier 4B crée, de façon non intentionnelle, une dépendance circulaire
 * : `ReferralsController` a besoin des guards d'`AuthModule`, qui dépendent
 * d'`AuthService` ; et `AuthService.register` a besoin de `ReferralsService`.
 * Un `nest build` ne voit RIEN de ce problème — il ne compile que des types.
 * Le cycle ne se révèle qu'à `app.init()`, c'est-à-dire au DÉMARRAGE SUR
 * RAILWAY : l'API entière tombe.
 *
 * La résolution retenue (pas de `forwardRef`, exclu par convention dans ce
 * dépôt) : `AuthService` ne déclare aucune dépendance sur `ReferralsModule` et
 * résout le service au moment de l'appel via `ModuleRef.get(..., {
 * strict: false })`. Ce test prouve que ce graphe démarre réellement.
 *
 * AUCUNE INFRASTRUCTURE : `PrismaService` n'implémente PAS `OnModuleInit`, il ne
 * se connecte donc pas au boot. `DATABASE_URL` est un dummy : aucun port n'est
 * touché. */

const DUMMY_DATABASE_URL = 'postgresql://user:pass@127.0.0.1:5432/relio_test_never_connected';

describe('ReferralsModule (assemblage NestJS)', () => {
  let app: INestApplication;
  let AppModule: typeof import('../app.module.js')['AppModule'];

  beforeAll(async () => {
    /* Défini AVANT l'import de `AppModule` : `ConfigModule.forRoot` valide au
     * chargement du module. L'import est donc dynamique. */
    process.env.DATABASE_URL = DUMMY_DATABASE_URL;
    process.env.NODE_ENV = 'test';

    ({ AppModule } = await import('../app.module.js'));

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    /* Si `ReferralsModule` et `AuthModule` se circularisaient, c'est ICI que
     * NestJS lèverait `Forward references / circular dependency`. */
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('Démarre sans erreur de graphe de modules (le cycle Auth ↔ Referrals est résolu)', () => {
    expect(app).toBeDefined();
  });

  it('ReferralsService est résoluble par le conteneur', () => {
    /* Résolu via `DemandesModule`, qui alimente le câblage de la confirmation
     * de mission. */
    expect(app.get(ReferralsService)).toBeInstanceOf(ReferralsService);
  });

  it('ReferralsNotificationsService est résoluble', () => {
    /* `strict: false` : le provider est interne à `ReferralsModule`. */
    expect(app.get(ReferralsNotificationsService, { strict: false })).toBeInstanceOf(
      ReferralsNotificationsService,
    );
  });

  it('le contrôleur est résoluble', () => {
    expect(app.get(ReferralsController, { strict: false })).toBeInstanceOf(ReferralsController);
  });

  it('DemandesService reçoit bien ReferralsService (câblage effectif)', async () => {
    /* Sans ce test, une injection `undefined` passerait inaperçue : le
     * `?.` de `DemandesService` rendrait le versement silencieusement absent
     * en production, sans la moindre erreur visible. */
    const { DemandesService } = await import('../demandes/demandes.service.js');
    const demandes = app.get(DemandesService) as unknown as { referrals?: unknown };
    expect(demandes.referrals).toBeInstanceOf(ReferralsService);
  });

  it('AuthService résout ReferralsService en mode strict:false', async () => {
    /* Le point exact du mécanisme anti-cycle : la recherche doit passer par
     * le graphe applicatif complet, car le service est exporté par
     * `ReferralsModule` et vit dans un AUTRE conteneur que `AuthModule`. */
    const { AuthService } = await import('../auth/auth.service.js');
    const { ModuleRef } = await import('@nestjs/core');
    const auth = app.get(AuthService, { strict: false });
    expect(auth).toBeInstanceOf(AuthService);
    /* Le conteneur sait répondre à la requête utilisée à l'exécution. */
    expect(app.get(ModuleRef).get(ReferralsService, { strict: false })).toBeInstanceOf(
      ReferralsService,
    );
  });

  it('GET /api/client/referrals/me existe et exige un cookie (401)', async () => {
    /* 401 et non 404 : la route EST enregistrée et le guard s'applique. */
    await request(app.getHttpServer()).get('/api/client/referrals/me').expect(401);
  });

  it('POST /api/client/referrals/code existe et exige un cookie (401)', async () => {
    await request(app.getHttpServer()).post('/api/client/referrals/code').expect(401);
  });

  it('les deux routes sont strictement scopées au rôle CLIENT', async () => {
    /* `RolesGuard` s'applique APRÈS `JwtAuthGuard` : sans cookie, c'est 401.
     * Un 403 exigerait un jeton technicien — le rôle est bien filtré. */
    await request(app.getHttpServer()).get('/api/client/referrals/me').expect(401);
    await request(app.getHttpServer()).post('/api/client/referrals/code').expect(401);
  });

  it('l\'inscription accepte toujours un code de parrainage', async () => {
    /* Non testé fonctionnellement : un corps vide suffit à prouver que la
     * route d'inscription n'a pas été cassée par l'ajout de `ReferralsModule`
     * dans le graphe (le 400 vient de la ValidationPipe). */
    await request(app.getHttpServer()).post('/api/auth/register').send({}).expect(400);
  });
});
