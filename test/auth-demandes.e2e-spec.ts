import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import cookieParser from 'cookie-parser';
import { AppModule } from './../src/app.module.js';

describe('Auth & Demandes (e2e)', () => {
  let app: INestApplication<App>;

  const unique = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.repairdom`;
  const client = {
    firstName: 'Test E2E',
    email: unique,
    password: 's3cret-E2E!',
  };

  let cookie = '';
  let demandeId = '';
  let demandeRef = '';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('POST /api/auth/register crée un client et pose un cookie HttpOnly', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send(client)
      .expect(201);
    expect(res.body.user.email).toBe(client.email);
    expect(res.body.user.passwordHash).toBeUndefined();

    const setCookies = (res.headers['set-cookie'] as unknown as string[]) ?? [];
    const auth = setCookies.find((c) => c.startsWith('repairdom_token='));
    expect(auth).toBeDefined();
    cookie = auth!.split(';')[0];
  });

  it('POST /api/auth/register avec un email dupliqué → 409', async () => {
    await request(app.getHttpServer())
      .post('/api/auth/register')
      .send(client)
      .expect(409);
  });

  it('GET /api/auth/me renvoie l utilisateur connecté', async () => {
    const res = await request(app.getHttpServer()).get('/api/auth/me').set('Cookie', cookie).expect(200);
    expect(res.body.email).toBe(client.email);
  });

  it('GET /api/auth/me sans cookie → 401', async () => {
    await request(app.getHttpServer()).get('/api/auth/me').expect(401);
  });

  it('POST /api/demandes crée une demande avec référence serveur', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/demandes')
      .set('Cookie', cookie)
      .send({
        categoryId: 'plomberie',
        description: 'Fuite sous l évier de la cuisine, le sol est mouillé.',
        city: 'Lyon',
        medias: [{ kind: 'IMAGE', name: 'fuite.jpg', mimeType: 'image/jpeg', sizeBytes: 102400 }],
      })
      .expect(201);

    expect(res.body.reference).toMatch(/^RD-[A-Z0-9]{6}$/);
    expect(res.body.status).toBe('SUBMITTED');
    expect(res.body.mediaPersisted).toBe(false);
    demandeId = res.body.id;
    demandeRef = res.body.reference;
  });

  it('GET /api/demandes liste les demandes du client', async () => {
    const res = await request(app.getHttpServer()).get('/api/demandes').set('Cookie', cookie).expect(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.some((d: { reference: string }) => d.reference === demandeRef)).toBe(true);
  });

  it('GET /api/demandes/:id renvoie le détail de sa demande', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/demandes/${demandeId}`)
      .set('Cookie', cookie)
      .expect(200);
    expect(res.body.reference).toBe(demandeRef);
  });

  it('POST /api/demandes sans authentification → 401', async () => {
    await request(app.getHttpServer())
      .post('/api/demandes')
      .send({ categoryId: 'plomberie', description: 'description valide assez longue', city: 'Lyon' })
      .expect(401);
  });

  it('POST /api/demandes avec un DTO invalide → 400', async () => {
    await request(app.getHttpServer())
      .post('/api/demandes')
      .set('Cookie', cookie)
      .send({ categoryId: 'inconnue', description: 'court', city: '' })
      .expect(400);
  });

  it('POST /api/auth/login + POST /api/auth/logout', async () => {
    const login = await request(app.getHttpServer())
      .post('/api/auth/login')
      .send({ email: client.email, password: client.password })
      .expect(200);
    const setCookies = (login.headers['set-cookie'] as unknown as string[]) ?? [];
    const auth = setCookies.find((c) => c.startsWith('repairdom_token='));
    expect(auth).toBeDefined();

    await request(app.getHttpServer()).post('/api/auth/logout').expect(200);
  });
});