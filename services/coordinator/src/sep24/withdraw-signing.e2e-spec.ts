import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { bootAuthApp, anchorToken } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';

describe('the screen that asks a wallet to sign', () => {
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

  async function atStatus(
    status: 'CREATED' | 'MATCHED' | 'FUNDED' | 'FIAT_PAID',
    flow: 'TOP_UP' | 'WITHDRAW',
  ) {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const path = flow === 'WITHDRAW' ? 'withdraw' : 'deposit';
    const opened = await http()
      .post(`/sep24/transactions/${path}/interactive`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const url = new URL(opened.body.url as string);
    const id = url.pathname.split('/').pop() as string;
    const token = url.searchParams.get('token') as string;

    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: kp.publicKey() } });
    await prisma.kycVerification.create({
      data: {
        customerRef: kp.publicKey(),
        personId: link!.personId,
        status: 'ACCEPTED',
        screenedAt: new Date(),
        verifiedAt: new Date(),
      },
    });
    const order = await prisma.order.create({
      data: {
        tradeId: randomBytes(32).toString('hex'),
        userAddress: kp.publicKey(),
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

    const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];
    const page = await http().get(`/sep24/interactive/${id}`).set('Cookie', cookie);
    return { id, cookie, page };
  }

  it('never auto-refreshes the signing screen, because the wallet round trip outlasts any refresh', async () => {
    const { page } = await atStatus('MATCHED', 'WITHDRAW');
    expect(page.text).toMatch(/sign to lock your usdc/i);
    expect(page.text).not.toMatch(/http-equiv="refresh"/i);
  });

  it('does not offer the button before an LP is matched, where building it would 409', async () => {
    const { page } = await atStatus('CREATED', 'WITHDRAW');
    expect(page.text).not.toMatch(/sign in my wallet/i);
    expect(page.text).toMatch(/preparing your withdrawal/i);
  });

  it('waits, and keeps refreshing, while the escrow is funded and the rupiah is still coming', async () => {
    const { page } = await atStatus('FUNDED', 'WITHDRAW');
    expect(page.text).toMatch(/your usdc is in escrow/i);
    expect(page.text).not.toMatch(/send your rupiah/i);
    expect(page.text).not.toContain('BCA 999888777');
    expect(page.text).not.toMatch(/i received the rupiah/i);
    expect(page.text).toMatch(/http-equiv="refresh"/i);
  });

  it('asks for the second signature once the rupiah is marked paid, which is when the escrow accepts it', async () => {
    const { page } = await atStatus('FIAT_PAID', 'WITHDRAW');
    expect(page.text).toMatch(/confirm your rupiah arrived/i);
    expect(page.text).toMatch(/i received the rupiah/i);
    expect(page.text).not.toMatch(/send your rupiah/i);
    expect(page.text).not.toContain('BCA 999888777');
    expect(page.text).not.toMatch(/http-equiv="refresh"/i);
  });

  it('leaves a funded deposit on the instructions screen, which still refreshes', async () => {
    const { page } = await atStatus('FUNDED', 'TOP_UP');
    expect(page.text).toMatch(/send your rupiah/i);
    expect(page.text).toMatch(/http-equiv="refresh"/i);
  });

  it('serves both signing scripts as javascript, which script-src self admits', async () => {
    const { id, cookie } = await atStatus('MATCHED', 'WITHDRAW');
    for (const name of ['fund.js', 'release.js']) {
      const res = await http().get(`/sep24/interactive/${id}/${name}`).set('Cookie', cookie).expect(200);
      expect(res.headers['content-type']).toMatch(/javascript/);
      expect(res.text).toContain('FREIGHTER_EXTERNAL_MSG_REQUEST');
      expect(res.text).toContain('SUBMIT_TRANSACTION');
    }
  });

  it('points each script at its own builder, so neither can sign the other half of the trade', async () => {
    const { id, cookie } = await atStatus('MATCHED', 'WITHDRAW');
    const fund = await http().get(`/sep24/interactive/${id}/fund.js`).set('Cookie', cookie).expect(200);
    expect(fund.text).toContain("'/fund-tx'");
    expect(fund.text).not.toContain("'/release-tx'");

    const release = await http().get(`/sep24/interactive/${id}/release.js`).set('Cookie', cookie).expect(200);
    expect(release.text).toContain("'/release-tx'");
    expect(release.text).not.toContain("'/fund-tx'");
  });

  it('refuses either signing script without the session cookie, and serves it with one', async () => {
    const { id, cookie } = await atStatus('MATCHED', 'WITHDRAW');
    for (const name of ['fund.js', 'release.js']) {
      const refused = await http().get(`/sep24/interactive/${id}/${name}`);
      expect(refused.status).toBe(401);
      expect(refused.text).not.toContain(process.env.STELLAR_RPC_URL as string);

      const served = await http().get(`/sep24/interactive/${id}/${name}`).set('Cookie', cookie);
      expect(served.status).toBe(200);
      expect(served.text).toContain(process.env.STELLAR_RPC_URL as string);
    }
  });

  it.each(['fund-tx', 'release-tx'])(
    'refuses %s on a deposit, so the depositor is never handed the provider half of the trade',
    async (path) => {
      const { id, cookie } = await atStatus('MATCHED', 'TOP_UP');
      const res = await http().get(`/sep24/interactive/${id}/${path}`).set('Cookie', cookie);
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/only a withdrawal/i);
    },
  );

  it.each(['fund-tx', 'release-tx'])(
    'refuses %s before an amount has been named, rather than dereferencing an order that is not there',
    async (path) => {
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

      const link = await prisma.walletLink.findUnique({ where: { stellarAddress: kp.publicKey() } });
      await prisma.kycVerification.create({
        data: {
          customerRef: kp.publicKey(),
          personId: link!.personId,
          status: 'ACCEPTED',
          screenedAt: new Date(),
          verifiedAt: new Date(),
        },
      });
      const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
      const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];

      const res = await http().get(`/sep24/interactive/${id}/${path}`).set('Cookie', cookie);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/amount|no order/i);
    },
  );

  it.each(['fund-tx', 'release-tx'])(
    'refuses %s from a foreign origin even holding a good cookie',
    async (path) => {
      const { id, cookie } = await atStatus('MATCHED', 'WITHDRAW');
      const res = await http()
        .get(`/sep24/interactive/${id}/${path}`)
        .set('Cookie', cookie)
        .set('Origin', 'https://evil.example');
      expect(res.status).toBe(403);
      expect(res.body.message).toMatch(/did not come from the page this anchor served/i);
    },
  );

  it('widens connect-src to the RPC on the interactive page, and nothing else', async () => {
    const { id, cookie } = await atStatus('MATCHED', 'WITHDRAW');
    const res = await http().get(`/sep24/interactive/${id}`).set('Cookie', cookie);
    const csp = res.headers['content-security-policy'] as string;
    const connect = csp.split(';').find((d) => d.trim().startsWith('connect-src')) as string;
    expect(connect).toBeDefined();
    expect(connect.trim()).toBe(
      `connect-src 'self' ${new URL(process.env.STELLAR_RPC_URL as string).origin}`,
    );
    const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src ')) as string;
    expect(scriptSrc.trim()).toBe("script-src 'self'");
  });

  it('leaves every other route on the untouched default policy', async () => {
    const res = await http().get('/sep24/info');
    const csp = res.headers['content-security-policy'] as string;
    expect(csp).not.toMatch(/connect-src/);
  });
});
