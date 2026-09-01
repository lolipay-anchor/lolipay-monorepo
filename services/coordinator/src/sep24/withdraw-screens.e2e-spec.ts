import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
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

  async function linkFundedOrder(
    id: string,
    address: string,
    flow: 'TOP_UP' | 'WITHDRAW',
    status: 'FUNDED' | 'FIAT_PAID' = 'FUNDED',
  ) {
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: address } });
    const order = await prisma.order.create({
      data: {
        tradeId: randomBytes(32).toString('hex'),
        userAddress: address,
        personId: link!.personId,
        flow,
        rail: 'BANK',
        usdcAmount: 1_000_0000000n,
        fiatAmount: 16_000_000n,
        rateSnapshot: '16000',
        platformFeeBps: 30,
        lpFeeBps: 0,
        platformWallet: 'GPLATFORM',
        lpPaymentDetails: 'BCA 999888777 THE PROVIDER',
        userPaymentDetails: 'BNI 111222333 THE USER',
        status,
        payDeadline: 9_999_999_999n,
        confirmDeadline: 9_999_999_999n,
        disputeDeadline: 9_999_999_999n,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.sep24Transaction.update({ where: { id }, data: { orderId: order.id } });
  }

  it('a FUNDED withdrawal is never told to send rupiah, and is never shown the provider bank account', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkFundedOrder(id, address, 'WITHDRAW');

    const res = await screen(id, token);
    expect(res.text).not.toMatch(/send your rupiah/i);
    expect(res.text).not.toContain('BCA 999888777');
    expect(res.text).toMatch(/your usdc is in escrow/i);
  });

  it('does not offer the confirm button at FUNDED, the one status the escrow refuses it at', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkFundedOrder(id, address, 'WITHDRAW');

    const res = await screen(id, token);
    expect(res.text).not.toMatch(/i received the rupiah/i);
    expect(res.text).toMatch(/http-equiv="refresh"/i);
  });

  it('offers the confirm button at FIAT_PAID, which is the only status confirm_and_release accepts', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkFundedOrder(id, address, 'WITHDRAW', 'FIAT_PAID');

    const res = await screen(id, token);
    expect(res.text).toMatch(/confirm your rupiah arrived/i);
    expect(res.text).toMatch(/i received the rupiah/i);
    expect(res.text).toMatch(/releases your usdc to the provider/i);
    expect(res.text).toMatch(/cannot be undone/i);
    expect(res.text).toContain('BNI 111222333 THE USER');
    expect(res.text).not.toContain('BCA 999888777');
  });

  it('leaves a FIAT_PAID deposit on the settled status page, with no button', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await prisma.sep24Transaction.update({ where: { id }, data: { flow: 'TOP_UP' } });
    await linkFundedOrder(id, address, 'TOP_UP', 'FIAT_PAID');

    const res = await screen(id, token);
    expect(res.text).toMatch(/deposit status/i);
    expect(res.text).not.toMatch(/i received the rupiah/i);
  });

  it('a FUNDED deposit still is told to send rupiah, with the provider bank account', async () => {
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
    await linkFundedOrder(id, kp.publicKey(), 'TOP_UP');

    const res = await screen(id, token);
    expect(res.text).toMatch(/send your rupiah/i);
    expect(res.text).toContain('BCA 999888777');
  });

  it('a settled withdrawal reports withdrawal status, not deposit status', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: address } });
    const order = await prisma.order.create({
      data: {
        tradeId: randomBytes(32).toString('hex'),
        userAddress: address,
        personId: link!.personId,
        flow: 'WITHDRAW',
        rail: 'BANK',
        usdcAmount: 1_000_0000000n,
        fiatAmount: 16_000_000n,
        rateSnapshot: '16000',
        platformFeeBps: 30,
        lpFeeBps: 0,
        platformWallet: 'GPLATFORM',
        status: 'RELEASED',
        payDeadline: 9_999_999_999n,
        confirmDeadline: 9_999_999_999n,
        disputeDeadline: 9_999_999_999n,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.sep24Transaction.update({ where: { id }, data: { orderId: order.id } });

    const res = await screen(id, token);
    expect(res.text).toMatch(/withdrawal status/i);
    expect(res.text).not.toMatch(/deposit status/i);
  });

  it('the page a failed step lands on names neither direction, because it cannot know which', async () => {
    const { id, token } = await openedWithdrawal(true);
    const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];

    const res = await http()
      .post(`/sep24/interactive/${id}/identity`)
      .set('Cookie', cookie)
      .set('Origin', process.env.ANCHOR_BASE_URL ?? 'http://localhost')
      .send({});

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).not.toMatch(/deposit/i);
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
