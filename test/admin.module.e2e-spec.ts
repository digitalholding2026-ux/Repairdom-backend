import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from './../src/app.module.js';
import { AdminService } from './../src/admin/admin.service.js';
import { AdminController } from './../src/admin/admin.controller.js';
import { RealtimeService } from './../src/realtime/realtime.service.js';
import { PushService } from './../src/push/push.service.js';
import { EmailService } from './../src/auth/email.service.js';

/* Garde-fou assemblage NestJS — chantier #5A.
 *
 * Le chantier #5A ajoute 4 injections à `AdminService` (RealtimeService,
 * PushService, EmailService, ConfigService) et 2 imports à `AdminModule`
 * (RealtimeModule, PushModule). Une dépendance manquante ou non exportée ne se
 * voit PAS à la compilation TypeScript : elle n'apparaît qu'au `app.init()`,
 * c'est-à-dire au démarrage de Railway. Ce test l'attrape avant.
 *
 * C'est la leçon du crash `web-push` / `JwtAuthGuard` : on vérifie que
 * l'injection est RÉELLEMENT résolue par le conteneur, pas seulement typée.
 *
 * Ne touche pas à la base (aucune requête émise ici). */

describe('AdminModule (e2e) — assemblage des canaux de notification KYC', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  it('démarre sans UnknownDependenciesException', () => {
    expect(app).toBeDefined();
  });

  it('AdminService est résolvable', () => {
    expect(app.get(AdminService)).toBeInstanceOf(AdminService);
  });

  it('AdminController est résolvable', () => {
    expect(app.get(AdminController)).toBeInstanceOf(AdminController);
  });

  /* Les 3 canaux injectés doivent être les MÊMES singletons que ceux
   * utilisés ailleurs : deux instances RealtimeService signifieraient deux
   * hubs SSE distincts et des notifications perdues. */
  it('les canaux injectés dans AdminService sont les singletons du conteneur', () => {
    const adminService = app.get(AdminService) as unknown as {
      realtime?: RealtimeService;
      push?: PushService;
      email?: EmailService;
    };

    expect(adminService.realtime).toBe(app.get(RealtimeService));
    expect(adminService.push).toBe(app.get(PushService));
    expect(adminService.email).toBe(app.get(EmailService));
  });

  afterEach(async () => {
    await app.close();
  });
});