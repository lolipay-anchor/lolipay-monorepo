import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, sessionToken, anchorToken } from './auth-test-helpers';

describe('the token class is enforced by the running application, not only by its own unit test', () => {
  let app: INestApplication;
  let kp: Keypair;

  beforeAll(async () => {
    app = await bootAuthApp();
    kp = Keypair.random();
  });

  afterAll(async () => {
    await app.close();
  });

  it('admits a session token to an ordinary user route', async () => {
    const jwt = await sessionToken(app, kp);
    await request(app.getHttpServer())
      .get('/profile')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
  });

  it('refuses an anchor token on that same route, for that same address', async () => {
    const jwt = await anchorToken(app, kp);
    await request(app.getHttpServer())
      .get('/profile')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(403);
  });

  it('refuses it on every route a provider or an administrator would use', async () => {
    const jwt = await anchorToken(app, kp);
    for (const path of ['/lp/me', '/lp/assignments', '/lp/earnings', '/orders', '/admin/orders']) {
      await request(app.getHttpServer())
        .get(path)
        .set('Authorization', `Bearer ${jwt}`)
        .expect(403);
    }
  });
});
