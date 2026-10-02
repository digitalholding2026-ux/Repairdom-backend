import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { RealtimeService } from './../src/realtime/realtime.service.js';
import { RealtimeController } from './../src/realtime/realtime.controller.js';

/* Garde-fou assemblage NestJS : instancie l'application COMPLÈTE (tous les
 * modules, dont RealtimeModule). Échoue au compile/init si une dépendance
 * manque (ex. AuthService non visible de RealtimeModule → crash Railway),
 * AVANT la production. Ne touche pas à la base (aucune requête émise ici). */

describe('RealtimeModule (e2e)', () => {
  let app: INestApplication<App>;

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

  it('RealtimeService est résoluble', () => {
    expect(app.get(RealtimeService)).toBeInstanceOf(RealtimeService);
  });

  it('RealtimeController est résoluble', () => {
    expect(app.get(RealtimeController)).toBeInstanceOf(RealtimeController);
  });

  it('GET /api/realtime/user sans cookie → 401 (guard câblé)', () => {
    return request(app.getHttpServer()).get('/api/realtime/user').expect(401);
  });

  afterEach(async () => {
    await app.close();
  });
});
