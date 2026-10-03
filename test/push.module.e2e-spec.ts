import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module.js';
import { PushService } from './../src/push/push.service.js';
import { PushController } from './../src/push/push.controller.js';

/* Garde-fou assemblage NestJS (push) : boot complet + résolubilité.
 * Détecte toute dépendance manquante AVANT Railway. Sans VAPID en test :
 * l'envoi est désactivé proprement, la clé publique est null. */

describe('PushModule (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
  });

  it('PushService est résoluble', () => {
    expect(app.get(PushService)).toBeInstanceOf(PushService);
  });

  it('PushController est résoluble', () => {
    expect(app.get(PushController)).toBeInstanceOf(PushController);
  });

  it('GET /api/push/vapid-public-key public → 200', () => {
    return request(app.getHttpServer()).get('/api/push/vapid-public-key').expect(200);
  });

  it('POST /api/push/subscribe sans cookie → 401', () => {
    return request(app.getHttpServer())
      .post('/api/push/subscribe')
      .send({ subscription: { endpoint: 'https://x/y', keys: { p256dh: 'a', auth: 'b' } } })
      .expect(401);
  });

  afterEach(async () => {
    await app.close();
  });
});
