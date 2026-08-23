import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AppModule } from '../app.module';
import { AppConfigService } from '../config/app-config.service';
import { anchorCorsOptions } from './anchor-cors';

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
    const corsOrigins = app.get(AppConfigService).corsOrigins;
    app.use(
      require('cors')((req: { path: string }, done: (e: unknown, o: unknown) => void) =>
        done(null, anchorCorsOptions(req.path, corsOrigins)),
      ),
    );
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
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
});
