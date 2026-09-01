import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';

describe('a withdrawal is never described to the user as a deposit', () => {
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

  async function openedWithdrawal(verified: boolean) {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const opened = await http()
      .post('/sep24/transactions/withdraw/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const url = new URL(opened.body.url as string);
    const id = url.pathname.split('/').pop() as string;
    const token = url.searchParams.get('token') as string;

    if (verified) {
      const link = await prisma.walletLink.findUnique({
        where: { stellarAddress: kp.publicKey() },
      });
      await prisma.kycVerification.create({
        data: {
          customerRef: kp.publicKey(),
          personId: link!.personId,
          status: 'ACCEPTED',
          screenedAt: new Date(),
          verifiedAt: new Date(),
        },
      });
    }
    return { id, token, address: kp.publicKey() };
  }

  async function screen(id: string, token: string) {
    const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
    if (first.status !== 302) return first;
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];
    return http().get(`/sep24/interactive/${id}`).set('Cookie', cookie);
  }

  it('the identity screen says the withdrawal SPENDS from the wallet, never that it credits it', async () => {
    const { id, token, address } = await openedWithdrawal(false);
    const res = await screen(id, token);
    expect(res.text).toContain(address);
    expect(res.text).toMatch(/spends USDC from/i);
    expect(res.text).not.toMatch(/credits/i);
  });

  it('the amount screen asks how much to withdraw', async () => {
    const { id, token } = await openedWithdrawal(true);
    const res = await screen(id, token);
    expect(res.text).toMatch(/how much would you like to withdraw/i);
    expect(res.text).not.toMatch(/how much would you like to deposit/i);
  });

  it('more_info_url names it a withdrawal, and the acceptance suite fetches that page', async () => {
    const { id } = await openedWithdrawal(false);
    const res = await http().get(`/sep24/more-info/${id}`).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/lolipay withdrawal/);
    expect(res.text).not.toMatch(/lolipay deposit/);
  });

  it('a deposit keeps saying deposit, so the branch did not simply rename everything', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const opened = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const url = new URL(opened.body.url as string);
    const id = url.pathname.split('/').pop() as string;
    const token = url.searchParams.get('token') as string;

    const res = await screen(id, token);
    expect(res.text).toMatch(/credits/i);
    expect(res.text).not.toMatch(/spends USDC from/i);

    const info = await http().get(`/sep24/more-info/${id}`).expect(200);
    expect(info.text).toMatch(/lolipay deposit/);
  });
});
