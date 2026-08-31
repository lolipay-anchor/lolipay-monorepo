import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';

describe('the page never tells another site where the depositor came from', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootAuthApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function opened() {
    const jwt = await anchorToken(app, Keypair.random());
    const res = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    return { id: res.body.id, token: new URL(res.body.url).searchParams.get('token')! };
  }

  it('sends no-referrer on the hop that carries the token', async () => {
    const { id, token } = await opened();
    const hop = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(302);
    expect(hop.headers['referrer-policy']).toBe('no-referrer');
  });

  it('sends no-referrer on the page itself, which links out to the verification vendor', async () => {
    const { id, token } = await opened();
    const hop = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(302);
    const cookie = ([] as string[])
      .concat(hop.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const page = await http().get(`/sep24/interactive/${id}`).set('Cookie', cookie).expect(200);
    expect(page.headers['referrer-policy']).toBe('no-referrer');
  });
});
