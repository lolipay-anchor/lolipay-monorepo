import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';

describe('the page never tells another site where the depositor came from, and keeps its own Origin on form posts', () => {
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

  it('sends no-referrer on an error page rendered at a tokened URL, whose links would otherwise carry the token', async () => {
    const { id } = await opened();
    const refused = await http().get(`/sep24/interactive/${id}?token=forged`).expect(401);
    expect(refused.headers['referrer-policy']).toBe('no-referrer');
  });

  it('never renders a document at a URL that carries a token: with a live session cookie the tokened link is answered with a redirect to the clean URL, whatever the token says', async () => {
    const { id, token } = await opened();
    const hop = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(302);
    const cookie = ([] as string[])
      .concat(hop.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const again = await http().get(`/sep24/interactive/${id}?token=${token}`).set('Cookie', cookie).expect(302);
    expect(again.headers.location).toBe(`/sep24/interactive/${id}`);
    expect(again.headers['referrer-policy']).toBe('no-referrer');
    const forged = await http().get(`/sep24/interactive/${id}?token=forged`).set('Cookie', cookie).expect(302);
    expect(forged.headers.location).toBe(`/sep24/interactive/${id}`);
    expect(forged.headers['referrer-policy']).toBe('no-referrer');
  });

  it('sends same-origin on the page itself, whose URL carries no token: nothing reaches the verification vendor, and its own form posts keep the Origin header a no-referrer page would null', async () => {
    const { id, token } = await opened();
    const hop = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(302);
    const cookie = ([] as string[])
      .concat(hop.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const page = await http().get(`/sep24/interactive/${id}`).set('Cookie', cookie).expect(200);
    expect(page.headers['referrer-policy']).toBe('same-origin');
  });
});
