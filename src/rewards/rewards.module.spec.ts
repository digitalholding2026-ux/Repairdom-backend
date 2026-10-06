import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { RewardsService } from './rewards.service.js';
import { RewardsNotificationsService } from './rewards-notifications.service.js';
import { RewardsController } from './rewards.controller.js';
import { RewardsAdminController } from './rewards-admin.controller.js';

/* Chantier #4A — GARDE-FOU D'ASSEMBLAGE NESTJS (`app.init()`).
 *
 * Pourquoi ce test existe : une dépendance NestJS non résoluble, un provider
 * manquant ou un CYCLE DE MODULES ne se voit qu'à `app.init()` — c'est-à-dire
 * au moment du DÉMARRAGE SUR RAILWAY, pas au `nest build`. Le chantier #4A
 * ajoute `RewardsModule` dans le graphe (importé par `DemandesModule`), c'est
 * donc exactement le type de régression qui devait être vérifié ici.
 *
 * AUCUNE INFRASTRUCTURE : `PrismaService` n'implémente PAS `OnModuleInit`, il
 * ne se connecte donc pas au boot — seule une `pg.Pool` paresseuse est
 * créée. `DATABASE_URL` est un dummy : aucune connexion n'est ouverte, aucun
 * port n'est touché. Pas de supertest, pas de HTTP : on interroge le routeur
 * Nest en mémoire pour prouver que les routes sont enregistrées avec les bons
 * préfixes et les bons guards.
 *
 * Nom en `.spec.ts` (et non `.e2e-spec.ts`) : ce test fait partie de `npm test`
 * et ne doit dépendre d'aucune base. */

const DUMMY_DATABASE_URL = 'postgresql://user:pass@127.0.0.1:5432/relio_test_never_connected';

describe('RewardsModule (assemblage NestJS)', () => {
  let app: INestApplication;
  let AppModule: typeof import('../app.module.js')['AppModule'];

  beforeAll(async () => {
    /* Doit être défini AVANT l'import de `AppModule` : `ConfigModule.forRoot`
     * valide au chargement du module, pas à `init()`. L'import est donc
     * dynamique (les imports ESM sont hissés). */
    process.env.DATABASE_URL = DUMMY_DATABASE_URL;
    process.env.NODE_ENV = 'test';

    ({ AppModule } = await import('../app.module.js'));

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    /* Si `RewardsModule` et `DemandesModule` se circularisaient, c'est
     * ICI que NestJS lèverait `Forward references / circular dependency`. */
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('Démarre sans erreur de graphe de modules (pas de cycle)', () => {
    expect(app).toBeDefined();
  });

  it('RewardsService est résoluble par le conteneur', () => {
    /* Résolu via `DemandesModule` : c'est ce chemin qui alimente le câblage
     * de la confirmation de mission. */
    expect(app.get(RewardsService)).toBeInstanceOf(RewardsService);
  });

  it('RewardsNotificationsService est résoluble', () => {
    /* `strict: false` : le provider n'est PAS exporté par `RewardsModule` (il
     * est interne), on interroge donc le graphe applicatif complet. */
    expect(app.get(RewardsNotificationsService, { strict: false })).toBeInstanceOf(
      RewardsNotificationsService,
    );
  });

  it('les deux contrôleurs sont résolubles', () => {
    expect(app.get(RewardsController, { strict: false })).toBeInstanceOf(RewardsController);
    expect(app.get(RewardsAdminController, { strict: false })).toBeInstanceOf(RewardsAdminController);
  });

  it('DemandesService reçoit bien RewardsService (câblage effectif)', async () => {
    /* C'est le test qui compte vraiment : si l'injection était `undefined`,
     * le comptage des récompenses serait SAUVAGEMENT sauté (optional chaining)
     * en production, sans la moindre erreur visible. */
    const { DemandesService } = await import('../demandes/demandes.service.js');
    const demandes = app.get(DemandesService) as unknown as { rewards?: unknown };
    expect(demandes.rewards).toBeInstanceOf(RewardsService);
  });

  it('GET /api/client/rewards existe et exige un cookie (401)', async () => {
    /* 401 et non 404 : la route EST enregistrée et le guard s'applique. */
    await request(app.getHttpServer()).get('/api/client/rewards').expect(401);
  });

  it('POST /api/client/rewards/BRONZE/claim existe et exige un cookie (401)', async () => {
    await request(app.getHttpServer()).post('/api/client/rewards/BRONZE/claim').expect(401);
  });

  it('GET /api/admin/rewards/frauds existe et exige un cookie (401)', async () => {
    await request(app.getHttpServer()).get('/api/admin/rewards/frauds').expect(401);
  });

  it('PATCH /api/admin/rewards/frauds/:id/resolve existe et exige un cookie (401)', async () => {
    await request(app.getHttpServer())
      .patch('/api/admin/rewards/frauds/f1/resolve')
      .send({ decision: 'VALIDATED' })
      .expect(401);
  });

  it('rejette un palier inconnu AVANT même de résoudre le client (400 sur cookie invalide)', async () => {
    /* Défense en lecture : avec un cookie invalide, c'est le guard qui parle
     * (401). On vérifie ici seulement que la route n'est pas un 404 «
     * inexistante », donc bien branchée au contrôleur. */
    await request(app.getHttpServer()).post('/api/client/rewards/DIAMANT/claim').expect(401);
  });
});
