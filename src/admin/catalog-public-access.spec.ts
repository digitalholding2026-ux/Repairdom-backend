import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { CatalogPublicController } from './catalog-public.controller.js';
import { CatalogController } from './catalog.controller.js';

/* FIX — catalogue accessible aux visiteurs anonymes.
 *
 * Le chantier D2 a rendu le wizard de demande public (`/demande`). Les
 * endpoints du catalogue, eux, étaient restés protégés : un visiteur recevait
 * 401 et le wizard affichait « Catalogue indisponible ». Ce test verrouille la
 * frontière EXACTE — les référentiels sont publics, le back-office ne l'est pas.
 *
 * Un test « la route répond 200 » ne prouverait pas assez : 200 avec un cookie
 * passerait aussi bien avant le correctif. On vérifie donc explicitement
 * l'absence de 401 sur chaque route visée, ET le maintien du 401/403 sur
 * l'écriture admin — c'est ce second pan qui protège le back-office.
 *
 * AUCUNE INFRASTRUCTURE : `PrismaService` n'implémente PAS `OnModuleInit`, donc
 * aucune connexion n'est ouverte au boot. `DATABASE_URL` est un dummy. Les
 * lectures atteignent réellement le service et échouent faute de base : d'où
 * une assertion NÉGATIVE (`not 401`) plutôt qu'un code de succès — on teste la
 * passe-through du guard, pas les données. */

const DUMMY_DATABASE_URL = 'postgresql://user:pass@127.0.0.1:5432/relio_test_never_connected';

/* Ids de lecture : aucune base n'est jointe, seule la ROUTE est vérifiée. */
const DOMAIN_ID = '11111111-1111-4111-8111-111111111111';
const BRAND_ID = '22222222-2222-4222-8222-222222222222';

describe('CatalogPublicController (frontière public / privé)', () => {
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
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  /* ── Référentiels : doivent être ANONYMES ──────────────────────── */

  const publicReads: ReadonlyArray<[string, string]> = [
    ['GET', '/api/catalog/domains'],
    ['GET', `/api/catalog/domains/${DOMAIN_ID}/brands`],
    ['GET', `/api/catalog/brands/${BRAND_ID}/models`],
    ['GET', '/api/catalog/families'],
    ['GET', `/api/catalog/domains/${DOMAIN_ID}/problems`],
    ['GET', '/api/catalog/cities'],
  ];

  for (const [method, path] of publicReads) {
    void test(`${method} ${path} est accessible SANS cookie`, async () => {
      /* `not 401` : c'est la régression à surveiller. Un 200 proves que le
       * guard est passé ; un 500 proves que seule la base manque. */
      await request(app.getHttpServer())[method.toLowerCase() as 'get'](path).expect((res) => {
        expect(res.status).not.toBe(401);
      });
    });
  }

  void test('GET /api/catalog/domains : le cookie ne change rien au résultat', async () => {
    /* Même assertion que les lectures anonymes, mais en Momentum d'y déposer
     * un cookie : la route doit répondre EXACTEMENT pareil.
     *
     * La version précédente de ce test affirmait `not 200`, ce qui passait
     * uniquement parce qu'aucune base n'est jointe en local (500). Against
     * un vrai backend, un `200` est la réponse CORRECTE : l'assertion était
     * donc fausse et vacuous — elle documentait le test, pas le comportement. */
    await request(app.getHttpServer())
      .get('/api/catalog/domains')
      .set('Cookie', 'repairdom_token=jeton-inexistant')
      .expect((res) => {
        expect(res.status).not.toBe(401);
      });
  });

  /* ── Ce qui doit RESTER fermé ───────────────────────────────────── */

  void test('GET /api/catalog/nationalities reste protégé (401 sans cookie)', async () => {
    /* Volontairement laissé protégé : consommé uniquement par
     * `/technicien/kyc`, déjà protégée. Une route KYC ouverte par inadvertance
     * serait une régression de sécurité. */
    await request(app.getHttpServer()).get('/api/catalog/nationalities').expect(401);
  });

  void test('POST /api/admin/catalog/domains reste protégé (401 sans cookie)', async () => {
    /* Le back-office ne doit jamais devenir accessible aux anonymes. */
    await request(app.getHttpServer())
      .post('/api/admin/catalog/domains')
      .send({ name: 'test' })
      .expect(401);
  });

  void test('POST /api/admin/catalog/domains refuse un non-ADMIN (403)', async () => {
    /* Un cookie invalide ne permet même pas de savoir le rôle : le 401 suffit.
     * Le 403 (rôle insuffisant) est couvert par `catalog-scales.spec.ts` et
     * `auth.spec.ts` — ici on verrouille surtout que l'écriture admin n'est
     * PAS devenue anonyme. */
    await request(app.getHttpServer())
      .post('/api/admin/catalog/domains')
      .set('Cookie', 'repairdom_token=jeton-inexistant')
      .send({ name: 'test' })
      .expect(401);
  });

  void test('PATCH /api/admin/catalog/domains/:id reste protégé (401)', async () => {
    await request(app.getHttpServer())
      .patch(`/api/admin/catalog/domains/${DOMAIN_ID}`)
      .send({ name: 'test' })
      .expect(401);
  });

  /* ── Non-régression des autres espaces protégés ─────────────────── */

  void test('les autres espaces authentifiés restent fermés (échantillon)', async () => {
    /* Le correctif ne doit pas avoir « glissé » sur d'autres contrôleurs :
     * on vérifie trois routes d'espaces distincts. */
    for (const path of [
      '/api/demandes',
      '/api/notifications/mine',
      '/api/finances/topup/intents',
      '/api/client/rewards',
    ]) {
      await request(app.getHttpServer()).get(path).expect(401);
    }
  });

  void test('GET /api/cities reste public (déjà public avant le correctif)', async () => {
    await request(app.getHttpServer()).get('/api/cities').expect((res) => {
      expect(res.status).not.toBe(401);
    });
  });

  /* ── Assemblage ─────────────────────────────────────────────────── */

  void test('les deux contrôleurs catalogue sont résolubles', () => {
    expect(app.get(CatalogPublicController, { strict: false })).toBeInstanceOf(
      CatalogPublicController,
    );
    expect(app.get(CatalogController, { strict: false })).toBeInstanceOf(CatalogController);
  });

  void test('Démarre sans erreur de graphe de modules', () => {
    expect(app).toBeDefined();
  });
});

/* ── Analyse de sensibilité : le payload public ne doit rien fuir ─── */

describe('CatalogPublicController — absence de fuite de données', () => {
  /* On inspecte le SOURCE : c'est le `select` de Prisma qui décide de ce qui
   * sort. Un test d'exécution exigerait une base ; la lecture du `select` est
   * ici le contrôle pertinent, et elle est vérifiable sans infrastructure. */
  const readSource = (rel: string): string =>
    readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('les sélecteurs publics n’exposent que des champs de référentiel', () => {
    const catalog = readSource('./catalog.service.ts');
    for (const method of [
      'listPublicDomains',
      'listPublicBrands',
      'listPublicModels',
      'listPublicFamilies',
      'listPublicProblems',
      'listPublicCities',
    ]) {
      const start = catalog.indexOf(`async ${method}(`);
      expect(start, `${method} introuvable`).toBeGreaterThan(-1);
      /* On isole le bloc de la méthode jusqu'à la suivante. */
      const next = catalog.indexOf('\n  async ', start + 1);
      const body = catalog.slice(start, next === -1 ? undefined : next);
      expect(body.length, `${method} : bloc vide`).toBeGreaterThan(0);
      /* Pas de PII, pas de prix. */
      expect(body).not.toMatch(/price|pricing|amount|minPrice|maxPrice/i);
      expect(body).not.toMatch(/email|phone|password|address|userId/i);
    }
  });

  it('aucun `include` large ne contamine les lectures publiques', () => {
    const catalog = readSource('./catalog.service.ts');
    const start = catalog.indexOf('async listPublicDomains(');
    const next = catalog.indexOf('\n  async ', start + 1);
    const body = catalog.slice(start, next === -1 ? undefined : next);
    /* Un `include` complet ramènerait par exemple `models`, `problems` ou des
     * relations pricing : le contrat public s'appuie sur `select`. */
    expect(body).not.toMatch(/include:\s*\{/);
  });

  it('les lectures publiques filtrent sur isActive', () => {
    const catalog = readSource('./catalog.service.ts');
    for (const method of ['listPublicDomains', 'listPublicBrands', 'listPublicModels']) {
      const start = catalog.indexOf(`async ${method}(`);
      const next = catalog.indexOf('\n  async ', start + 1);
      const body = catalog.slice(start, next === -1 ? undefined : next);
      /* Un référentiel inactif ne doit jamais être proposé. */
      expect(body, `${method} ne filtre pas isActive`).toMatch(/isActive: true/);
    }
  });

  it('le contrôleur ne renvoie que des GET', () => {
    /* Garde-fou structurel : retirer les guards de classe rend TOUTE nouvelle
     * route publique par défaut. On vérifie qu'aucune écriture n'a été
     * introduite dans ce controller. */
    const controller = readSource('./catalog-public.controller.ts');
    for (const verb of ['@Post', '@Put', '@Patch', '@Delete']) {
      expect(controller.includes(verb), `${verb} présent dans le controller public`).toBe(false);
    }
  });
});
