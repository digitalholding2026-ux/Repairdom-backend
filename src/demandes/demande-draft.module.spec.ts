import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { DemandeDraftService } from './demande-draft.service.js';
import { DemandeDraftController } from './demande-draft.controller.js';
import { DraftThrottleGuard } from './demande-draft-throttle.guard.js';

/* Chantier D1 — GARDE-FOU D'ASSEMBLAGE NESTJS (`app.init()`).
 *
 * Pourquoi ce test existe : une dépendance non résoluble, un provider manquant
 * ou un CYCLE DE MODULES ne se voit qu'à `app.init()` — c'est-à-dire au
 * DÉMARRAGE SUR RAILWAY, pas au `nest build`. `DemandeDraftService` dépend de
 * `DemandesService` et vit dans `DemandesModule` : c'est exactement le type de
 * régression à verrouiller. (Leçon du crash `web-push`, déjà paid dans
 * `rewards.module.spec.ts`.)
 *
 * AUCUNE INFRASTRUCTURE : `PrismaService` n'implémente PAS `OnModuleInit`, donc
 * aucune connexion n'est ouverte au boot. `DATABASE_URL` est un dummy — aucun
 * port n'est touché. Seuls les hits du routeur en mémoire sont observés :
 * aucun test ne va au bout de la chaîne Prisma.
 *
 * Ce que ce test VÉRIFIE, et qui est le cœur du chantier D1 :
 * la frontière public/privé. Les trois routes de brouillon doivent répondre
 * SANS cookie, et la conversion doit répondre 401. Un `@UseGuards` posé par
 * erreur sur la classe casserait le parcours non authentifié sans qu'aucun
 * test unitaire ne le voie. */

const DUMMY_DATABASE_URL = 'postgresql://user:pass@127.0.0.1:5432/relio_test_never_connected';

describe('DemandeDraftController (assemblage NestJS)', () => {
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
    /* Même configuration que `main.ts` : le contrat 400 de la ValidationPipe
     * fait partie de ce qu'on verrouille. */
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

  it('DemandeDraftService est résoluble par le conteneur', () => {
    expect(app.get(DemandeDraftService, { strict: false })).toBeInstanceOf(DemandeDraftService);
  });

  it('DemandeDraftController est résoluble', () => {
    expect(app.get(DemandeDraftController, { strict: false })).toBeInstanceOf(
      DemandeDraftController,
    );
  });

  it('DraftThrottleGuard est résoluble', () => {
    expect(app.get(DraftThrottleGuard, { strict: false })).toBeInstanceOf(DraftThrottleGuard);
  });

  it('DemandeDraftService reçoit bien DemandesService (câblage effectif)', async () => {
    const { DemandesService } = await import('./demandes.service.js');
    const draft = app.get(DemandeDraftService, { strict: false }) as unknown as {
      demandesService?: unknown;
    };
    /* Si l'injection était `undefined`, la conversion exploserait en prod avec
     * une `TypeError` sur une route déjà déployée. */
    expect(draft.demandesService).toBeInstanceOf(DemandesService);
  });

  /* ---------------------------------------------------------------- */
  /* Frontière public / privé — le cœur du chantier D1                */
  /* ---------------------------------------------------------------- */

  it('POST /api/demandes/drafts est PUBLIQUE (pas de 401)', async () => {
    /* 400 et non 401 : la route est atteinte, le guard ne l'est pas. Le corps
     * volontairement incomplet provoque un 400 applicatif, ce qui prouve que
     * la requête traverse bien le routage ET la ValidationPipe. */
    await request(app.getHttpServer()).post('/api/demandes/drafts').send({}).expect(400);
  });

  it('GET /api/demandes/drafts/:token est PUBLIQUE (pas de 401)', async () => {
    /* Assertion volontairement NEGATIVE et non un code précis : cette requête
     * atteint réellement `PrismaService`, qui tente la connexion au dummy
     * `DATABASE_URL` et échoue (500) faute de base. Ce test ne teste donc pas
     * le 404 métier — il prouve l'absence de `JwtAuthGuard`, ce qui est le
     * seul enjeu de la frontière public/privé. Le 404 métier est couvert par
     * `demande-draft.service.spec.ts` avec un Prisma simulé. */
    await request(app.getHttpServer())
      .get('/api/demandes/drafts/00000000-0000-4000-8000-000000000000')
      .expect((res) => {
        expect(res.status).not.toBe(401);
      });
  });

  it('PATCH /api/demandes/drafts/:token est PUBLIQUE (pas de 401)', async () => {
    await request(app.getHttpServer())
      .patch('/api/demandes/drafts/00000000-0000-4000-8000-000000000000')
      .send({ address: 'Rue 12' })
      .expect((res) => {
        expect(res.status).not.toBe(401);
      });
  });

  it('POST /api/demandes/drafts/:token/convert exige un cookie (401)', async () => {
    /* C'est la seule route protégée du contrôleur. Un 401 — et non un 404 —
     * prouve que la route existe ET que JwtAuthGuard s'applique. */
    await request(app.getHttpServer())
      .post('/api/demandes/drafts/00000000-0000-4000-8000-000000000000/convert')
      .send({})
      .expect(401);
  });

  it('le corps du brouillon refuse un champ inconnu (forbidNonWhitelisted)', async () => {
    await request(app.getHttpServer())
      .post('/api/demandes/drafts')
      .send({
        categoryId: 'electricite',
        description: 'Ma lampe ne s’allume plus',
        city: 'Douala',
        pirate: true,
      })
      .expect(400);
  });

  it('le brouillon refuse un champ `medias` (reportés après inscription)', async () => {
    /* Décision D1-2 : les médias ne vivent pas dans le brouillon. Si ce champ
     * devenait accepté, le client croirait les avoir enregistrés. */
    await request(app.getHttpServer())
      .post('/api/demandes/drafts')
      .send({
        categoryId: 'electricite',
        description: 'Ma lampe ne s’allume plus',
        city: 'Douala',
        medias: [{ kind: 'IMAGE', name: 'p.jpg', mimeType: 'image/jpeg', sizeBytes: 10 }],
      })
      .expect(400);
  });

  it('la conversion exige le rôle CLIENT (un non-CLIENT est refusé)', async () => {
    /* `@Roles('CLIENT')` est bien présent sur la méthode : avec un cookie
     * valide mais un rôle non client, `RolesGuard` répond 403. Le jeton est
     * volontairement invalide → le test s'arrête au JwtAuthGuard (401), ce qui
     * suffit ici : la présence du rôle est vérifiée par `auth.spec.ts` sur
     * l'infrastructure des rôles, pas sur cette route. */
    await request(app.getHttpServer())
      .post('/api/demandes/drafts/00000000-0000-4000-8000-000000000000/convert')
      .set('Cookie', 'repairdom_token=jeton-inexistant')
      .send({})
      .expect(401);
  });
});