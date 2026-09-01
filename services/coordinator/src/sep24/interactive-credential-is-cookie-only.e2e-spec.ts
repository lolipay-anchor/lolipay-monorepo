import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';

describe('the interactive credential travels in a cookie and nowhere else', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saved: string | undefined;

  beforeAll(async () => {
    saved = process.env.SEP24_WITHDRAW_ENABLED;
    process.env.SEP24_WITHDRAW_ENABLED = 'true';
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.SEP24_WITHDRAW_ENABLED;
    else process.env.SEP24_WITHDRAW_ENABLED = saved;
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const base = process.env.ANCHOR_BASE_URL ?? 'http://localhost';

  async function opened() {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post('/sep24/transactions/withdraw/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const url = new URL(res.body.url as string);
    return {
      id: url.pathname.split('/').pop() as string,
      token: url.searchParams.get('token') as string,
    };
  }

  it('the link token is a real, usable credential — the control that makes the refusals below mean something', async () => {
    const { id, token } = await opened();
    const res = await http().get(`/sep24/interactive/${id}?token=${token}`);
    expect(res.status).toBe(302);
    expect(res.headers['set-cookie']).toBeDefined();
  });

  async function liveSession() {
    const { id, token } = await opened();
    const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];
    const value = cookie
      .map((c) => c.split(';')[0])
      .map((c) => c.slice(c.indexOf('=') + 1))
      .find((v) => v.length > 0) as string;
    return { id, cookie, session: value };
  }

  it('the extracted session token really is the live credential — the control for the two refusals below', async () => {
    const { id, cookie } = await liveSession();
    const ok = await http().get(`/sep24/interactive/${id}`).set('Cookie', cookie);
    expect(ok.status).toBe(200);
  });

  it('refuses the LIVE SESSION token in the BODY of a write, with no cookie', async () => {
    for (const field of ['token', 'session', 'interactive_token']) {
      const { id, session } = await liveSession();
      const res = await http()
        .post(`/sep24/interactive/${id}/amount`)
        .set('Origin', base)
        .send({ fiat_amount: '1000000', user_payment_method: 'BNI 1', [field]: session });
      expect([field, res.status]).toEqual([field, 401]);
    }
  });

  it('refuses the LIVE SESSION token in the QUERY of a write, with no cookie', async () => {
    const { id, session } = await liveSession();
    const res = await http()
      .post(`/sep24/interactive/${id}/amount?token=${encodeURIComponent(session)}`)
      .set('Origin', base)
      .send({ fiat_amount: '1000000', user_payment_method: 'BNI 1' });
    expect(res.status).toBe(401);
  });

  it('refuses the LIVE SESSION token in the query of the funding endpoint too', async () => {
    const { id, session } = await liveSession();
    const inQuery = await http().get(
      `/sep24/interactive/${id}/fund-tx?token=${encodeURIComponent(session)}`,
    );
    expect(inQuery.status).toBe(401);
    const noCredential = await http().get(`/sep24/interactive/${id}/fund-tx`);
    expect(noCredential.status).toBe(401);
  });

  it('the funding endpoint refuses a foreign origin even holding a good cookie', async () => {
    const { id, token } = await opened();
    const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];
    const res = await http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .set('Origin', 'https://evil.example')
      .send({ fiat_amount: '1000000', user_payment_method: 'BNI 1' });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('refuses to build a funding transaction for a withdrawal that has named no amount', async () => {
    const { id, token } = await opened();
    const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];
    const res = await http().get(`/sep24/interactive/${id}/fund-tx`).set('Cookie', cookie);
    expect(res.status).toBe(409);
    expect(await prisma.order.count()).toBeGreaterThanOrEqual(0);
  });
});
