import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';

describe('the popup a wallet opens, and what it will not do for a stranger', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });
  afterAll(async () => {
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function opened() {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const url = new URL(res.body.url);
    return { kp, id: res.body.id, token: url.searchParams.get('token')!, jwt };
  }

  it('serves the identity form as html, with no bearer token in sight', async () => {
    const { id, token } = await opened();
    const res = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toContain('<form');
    expect(res.text).toMatch(/first_name/);
  });

  it('carries no script, because a page with none cannot be told to run one', async () => {
    const { id, token } = await opened();
    const res = await http().get(`/sep24/interactive/${id}?token=${token}`);
    expect(res.text).not.toMatch(/<script/i);
    expect(res.text).not.toMatch(/onclick=/i);
  });

  it('refuses a link with no token', async () => {
    const { id } = await opened();
    await http().get(`/sep24/interactive/${id}`).expect(401);
  });

  it('refuses a token minted for a different transaction', async () => {
    const a = await opened();
    const b = await opened();
    await http().get(`/sep24/interactive/${a.id}?token=${b.token}`).expect(401);
  });

  it('refuses a transaction that does not exist, even with a well-formed token', async () => {
    const { token } = await opened();
    await http()
      .get(`/sep24/interactive/7a1f0c9e-0000-4000-8000-0000000000ff?token=${token}`)
      .expect(401);
  });

  it('will not take an amount from a caller whose identity was never screened', async () => {
    const { id, token } = await opened();
    await http()
      .post(`/sep24/interactive/${id}/amount?token=${token}`)
      .send({ fiat_amount: '400000' })
      .expect(403);
  });

  it('tells a refused identity so, and offers it nothing', async () => {
    const { id, token, kp } = await opened();
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: kp.publicKey() } });
    await prisma.kycVerification.create({
      data: {
        customerRef: kp.publicKey(),
        personId: link!.personId,
        status: 'REJECTED',
        rejectionReason: 'sanctions or watchlist match',
      },
    });
    const res = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(200);
    expect(res.text).toMatch(/refused/i);
    expect(res.text).not.toContain('<form');
  });

  it('asks for an amount once a screening has actually happened', async () => {
    const { id, token, kp } = await opened();
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: kp.publicKey() } });
    await prisma.kycVerification.create({
      data: {
        customerRef: kp.publicKey(),
        personId: link!.personId,
        status: 'ACCEPTED',
        screenedAt: new Date(),
      },
    });
    const res = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(200);
    expect(res.text).toMatch(/fiat_amount/);
  });

  it('waits rather than asking, while identity passed but screening has not', async () => {
    const { id, token, kp } = await opened();
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: kp.publicKey() } });
    await prisma.kycVerification.create({
      data: { customerRef: kp.publicKey(), personId: link!.personId, status: 'ACCEPTED' },
    });
    const res = await http().get(`/sep24/interactive/${id}?token=${token}`).expect(200);
    expect(res.text).toContain('http-equiv="refresh"');
    expect(res.text).not.toMatch(/fiat_amount/);
  });
});
