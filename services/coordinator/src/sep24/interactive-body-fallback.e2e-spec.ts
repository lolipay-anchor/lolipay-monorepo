import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { SEP24_INTERACTIVE_LINK_TTL_SECS, SEP24_INTERACTIVE_TTL_SECS } from './interactive-token';

describe('the token from a leaked URL cannot be spent by a client that never held the cookie', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootAuthApp();
  });
  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function follow(_app: INestApplication, id: string, token: string) {
    const hop = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(302);
    const cookie = ([] as string[])
      .concat(hop.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    return {
      cookie,
      page: () => http().get(`/sep24/interactive/${id}`).set('Cookie', cookie),
    };
  }

  async function opened() {
    const jwt = await anchorToken(app, Keypair.random());
    const res = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    return { id: res.body.id, token: new URL(res.body.url).searchParams.get('token')! };
  }

  it('refuses an amount carried in the body with no cookie, which is all a log line gives an attacker', async () => {
    const { id, token } = await opened();
    await http()
      .post(`/sep24/interactive/${id}/amount`)
      .send({ token, fiat_amount: '400000' })
      .expect(401);
  });

  const life = (t: string) => {
    const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
    return p.exp - p.iat;
  };

  it('hands the wallet a link that dies long before the session it opens', async () => {
    const { token } = await opened();
    expect(life(token)).toBe(SEP24_INTERACTIVE_LINK_TTL_SECS);
    expect(SEP24_INTERACTIVE_LINK_TTL_SECS).toBeLessThan(SEP24_INTERACTIVE_TTL_SECS);
  });

  it('does not reuse the link token as the session, so the session outlives the link', async () => {
    const { id, token } = await opened();
    const hop = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(302);
    const set = ([] as string[]).concat(hop.headers['set-cookie'] ?? [])[0];
    const seated = set.split(';')[0].split('=').slice(1).join('=');
    expect(seated).not.toBe(token);
    expect(life(decodeURIComponent(seated))).toBe(SEP24_INTERACTIVE_TTL_SECS);
  });

  it('serves a depositor who reopens the same link, rather than refusing them over a spent token', async () => {
    const { id, token } = await opened();
    const hop = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(302);
    const cookie = ([] as string[])
      .concat(hop.headers['set-cookie'] ?? [])
      .map((c) => c.split(';')[0])
      .join('; ');
    const again = await http()
      .get(`/sep24/interactive/${id}?token=notatokenanymore`)
      .set('Cookie', cookie)
      .expect(200);
    expect(again.text).toContain('<form');
  });

  it('still redeems a valid link for a browser whose cookie is garbage', async () => {
    const { id, token } = await opened();
    await http()
      .get(`/sep24/interactive/${id}?token=${token}`)
      .set('Cookie', `${'sep24_' + id}=rubbish`)
      .expect(302);
  });

  it('refuses the link token presented as a session cookie, which is what a log line actually gives an attacker', async () => {
    const { id, token } = await opened();
    await http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', `sep24_${id}=${token}`)
      .send({ fiat_amount: '400000' })
      .expect(401);
    await http()
      .post(`/sep24/interactive/${id}/identity`)
      .set('Cookie', `sep24_${id}=${token}`)
      .send({ first_name: 'Budi', last_name: 'Santoso', email_address: 'budi@example.com' })
      .expect(401);
  });

  it('reseats the session on every render, so the page outlives the link that opened it', async () => {
    const { id, token } = await opened();
    const { cookie, page } = await follow(app, id, token);
    const again = await page().expect(200);
    const set = ([] as string[]).concat(again.headers['set-cookie'] ?? []);
    expect(set.length).toBe(1);
    expect(set[0]).toContain(`sep24_${id}=`);
    expect(cookie).toBeTruthy();
  });

  it('is not wedged by a cookie of the same name planted by another host', async () => {
    const { id, token } = await opened();
    const { cookie } = await follow(app, id, token);
    const res = await http()
      .get(`/sep24/interactive/${id}`)
      .set('Cookie', `sep24_${id}=planted; ${cookie}`)
      .expect(200);
    expect(res.text).toContain('<form');
  });

  it('does not offer a browser with no cookie a link that lands on the same refusal', async () => {
    const { id } = await opened();
    const res = await http().get(`/sep24/interactive/${id}`).expect(401);
    expect(res.text).not.toContain(`href="/sep24/interactive/${id}"`);
  });

  it('refuses an identity carried in the body with no cookie', async () => {
    const { id, token } = await opened();
    await http()
      .post(`/sep24/interactive/${id}/identity`)
      .send({ token, first_name: 'Budi', last_name: 'Santoso', email_address: 'budi@example.com' })
      .expect(401);
  });
});
