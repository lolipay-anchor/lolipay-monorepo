import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AppModule } from '../app.module';
import { AppConfigService } from '../config/app-config.service';
import { configureHttp } from '../http-setup';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

const STRANGER = 'https://lobstr.co';

describe('CORS on the anchor surface', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .compile();
    app = mod.createNestApplication();
    configureHttp(app);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers a stranger with a wildcard on GET /auth', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth?account=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')
      .set('Origin', STRANGER);

    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers a wildcard even when the request is refused', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth?account=invalid-account')
      .set('Origin', STRANGER)
      .expect(400);

    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers a wildcard on the token endpoint too, refusal included', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth')
      .set('Origin', STRANGER)
      .send({})
      .expect(400);

    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('answers the preflight SEP-10 requires', async () => {
    const res = await request(app.getHttpServer())
      .options('/auth')
      .set('Origin', STRANGER)
      .set('Access-Control-Request-Method', 'POST');

    expect(res.status).toBeLessThan(300);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(res.headers['access-control-allow-methods']).toContain('POST');
  });

  it('tells caches not to keep a challenge, which is single use', async () => {
    const res = await request(app.getHttpServer())
      .get('/auth?account=GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF')
      .set('Origin', STRANGER);

    expect(res.headers['cache-control']).toMatch(/no-store/);
  });

  it('does not hand a stranger the credentialed policy on an internal route', async () => {
    const res = await request(app.getHttpServer()).get('/profile').set('Origin', STRANGER);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still serves the allowlisted app with credentials on an internal route', async () => {
    const allowed = app.get(AppConfigService).corsOrigins[0];
    expect(allowed).toBeTruthy();

    const res = await request(app.getHttpServer()).get('/profile').set('Origin', allowed);

    expect(res.headers['access-control-allow-origin']).toBe(allowed);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
  });

  it('answers a wildcard even when the body never reaches a handler', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth')
      .set('Origin', STRANGER)
      .set('Content-Type', 'application/json')
      .send('{"transaction":');

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('answers a wildcard when the body is too large to parse', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth')
      .set('Origin', STRANGER)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ transaction: 'x'.repeat(200_000) }));

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('keeps the headers an authenticated browser needs on the internal preflight', async () => {
    const allowed = app.get(AppConfigService).corsOrigins[0];

    const res = await request(app.getHttpServer())
      .options('/orders/abc')
      .set('Origin', allowed)
      .set('Access-Control-Request-Method', 'PATCH');

    expect(res.headers['access-control-allow-methods']).toContain('PATCH');
    expect(res.headers['access-control-allow-methods']).toContain('DELETE');
    expect(res.headers['access-control-allow-headers']).toContain('Authorization');
  });

  it('applies the ordinary policy to a stranger rather than no policy at all', async () => {
    const res = await request(app.getHttpServer()).get('/profile').set('Origin', STRANGER);

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['vary']).toContain('Origin');
  });
});
