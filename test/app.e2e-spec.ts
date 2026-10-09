import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { HealthModule } from './../src/health/health.module.js';
import { HealthController } from './../src/health/health.controller.js';
import { AuthModule } from './../src/auth/auth.module.js';
import { DemandesModule } from './../src/demandes/demandes.module.js';
import { FinancialModule } from './../src/financial/financial.module.js';

/* ASSEMBLAGE DE L'APPLICATION — garde-fou de démarrage.
 *
 * Ce que Railway casse, en pratique, c'est le BOOT : une dépendance
 * d'injection non satisfaite, un module non importé, un provider qui lève au
 * chargement. Le symptomôme est un conteneur qui restart-loop sur une erreur
 * que personne ne voit, parce que les logs ont déjà rotationné.
 *
 * Ces tests montent le VRAI AppModule — pas un AppController de démonstration —
 * et vérifient que Nest résout le graphe complet. Ils n'ouvrent aucune
 * connexion sortante : aucune base n'est requise, ce qui les rend exécutables
 * en local et en CI sur une machine sans infrastructure.
 *
 * `describe('AppController')` était un squelette Nest CLI nommant un
 * AppController/AppService qui n'existent plus dans ce dépôt. Le nom est
 * « AppModule » : c'est le module assemblé qui est vérifié, pas un contrôleur.
 */

describe('assemblage AppModule (garde-fou de démarrage Railway)', () => {
  let moduleFixture: TestingModule;

  beforeAll(async () => {
    moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
  });

  afterAll(async () => {
    await moduleFixture.close();
  });

  it('le graphe de dépendances se compile sans erreur', () => {
    expect(moduleFixture).toBeDefined();
  });

  it('les modules métier sont bien assemblés dans AppModule', () => {
    // Chaque module absent ici = 404 sur toutes ses routes en production.
    for (const token of [HealthModule, AuthModule, DemandesModule, FinancialModule]) {
      expect(moduleFixture.get(token, { strict: false })).toBeDefined();
    }
  });

  it('HealthController est résolvable', () => {
    expect(moduleFixture.get(HealthController, { strict: false })).toBeInstanceOf(
      HealthController,
    );
  });
});

/* Le démarrage RÉEL (route HTTP + base joignable) reste couvert par le second
 * bloc : il exige une base, donc il tourne uniquement via `npm run test:e2e`
 * sur une CI disposant de Postgres, jamais dans `npm test`. */
describe('AppModule — démarrage réel (nécessite une base)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  it('/api/health (GET) returns service status', () => {
    return request(app.getHttpServer())
      .get('/api/health')
      .expect(200)
      .expect((res) => {
        expect(typeof res.body.uptime).toBe('number');
        expect(typeof res.body.timestamp).toBe('string');
        expect(['up', 'down']).toContain(res.body.database);
      });
  });

  afterEach(async () => {
    await app.close();
  });
});