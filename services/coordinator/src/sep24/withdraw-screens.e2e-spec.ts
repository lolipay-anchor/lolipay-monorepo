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
    await prisma.fiatPriceCache.deleteMany();
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
    expect(res.text).toMatch(/sign in with the same wallet at <a href="https:\/\/app\.lolipay\.app">app\.lolipay\.app<\/a>.*whether a dispute can still be opened and until when/);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toMatch(/lolipay withdrawal/);
    expect(res.text).not.toMatch(/lolipay deposit/);
  });

  async function linkOrder(
    id: string,
    address: string,
    flow: 'TOP_UP' | 'WITHDRAW',
    status: 'CREATED' | 'MATCHED' | 'AWAITING_ONCHAIN' | 'FUNDED' | 'FIAT_PAID' = 'FUNDED',
    payDeadline = 9_999_999_999n,
    confirmDeadline = 10_000_003_599n,
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
        payDeadline,
        confirmDeadline,
        disputeDeadline: 9_999_999_999n,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await prisma.sep24Transaction.update({ where: { id }, data: { orderId: order.id } });
  }

  it('states the USDC to be locked and the rupiah to be received before the wallet prompt, so the user signs a number they have read', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkOrder(id, address, 'WITHDRAW', 'MATCHED');

    const res = await screen(id, token);
    expect(res.text).toMatch(/sign to lock your usdc/i);
    expect(res.text).toMatch(/sign in my wallet/i);
    expect(res.text).toContain('<strong>1000</strong> USDC');
    expect(res.text).toContain('<strong>16.000.000</strong> IDR');
    expect(res.text).not.toContain('1000.0000000');
  });

  it('states the exchange rate the order holds and that it is fixed for this order', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkOrder(id, address, 'WITHDRAW', 'MATCHED');

    const res = await screen(id, token);
    expect(res.text).toMatch(/1 USDC ≈ <strong>16\.000<\/strong> IDR/);
    expect(res.text).toMatch(/fixed for this order/i);
    expect(res.text).not.toMatch(/estimate/i);
  });

  it('no longer explains where the spread goes, matching the deposit screen, which never did', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkOrder(id, address, 'WITHDRAW', 'MATCHED');

    const res = await screen(id, token);
    expect(res.text).not.toMatch(/no fee is deducted/i);
    expect(res.text).not.toMatch(/platform's share/i);
  });

  it('the withdrawal amount screen quotes the reference price minus the spread, and says the applied rate may differ from the estimate', async () => {
    await prisma.fiatPriceCache.upsert({
      where: { fiat: 'IDR' },
      update: { pricePerUsdc: '16000', fetchedAt: new Date(), source: 'test' },
      create: { fiat: 'IDR', pricePerUsdc: '16000', fetchedAt: new Date(), source: 'test' },
    });
    const { id, token } = await openedWithdrawal(true);
    const res = await screen(id, token);
    expect(res.text).toMatch(/1 USDC ≈ <strong>15\.760<\/strong> IDR right now/);
    expect(res.text).toMatch(/may differ from this one/i);
    expect(res.text).not.toMatch(/fee of/i);
  });

  it('the deposit amount screen quotes the reference price plus the spread and names the fee taken from the USDC, so the depositor can see their whole cost', async () => {
    await prisma.fiatPriceCache.upsert({
      where: { fiat: 'IDR' },
      update: { pricePerUsdc: '16000', fetchedAt: new Date(), source: 'test' },
      create: { fiat: 'IDR', pricePerUsdc: '16000', fetchedAt: new Date(), source: 'test' },
    });
    const { id, token } = await openedWithdrawal(true);
    await prisma.sep24Transaction.update({ where: { id }, data: { flow: 'TOP_UP' } });
    const res = await screen(id, token);
    expect(res.text).toMatch(/1 USDC ≈ <strong>16\.240<\/strong> IDR right now/);
    expect(res.text).toMatch(/A fee of 1\.5% is taken from the USDC you receive/);
  });

  it('a paused platform shows no estimate and says it is paused, because the next screen would refuse the order', async () => {
    const before = await prisma.config.findUniqueOrThrow({ where: { id: 1 }, select: { paused: true } });
    await prisma.config.update({ where: { id: 1 }, data: { paused: true } });
    try {
      const { id, token } = await openedWithdrawal(true);
      const res = await screen(id, token);
      expect(res.text).not.toMatch(/1 USDC ≈/);
      expect(res.text).toMatch(/paused right now/);
      expect(res.text).toMatch(/how much/i);
    } finally {
      await prisma.config.update({ where: { id: 1 }, data: { paused: before.paused } });
    }
  });

  it('names the last instant the escrow accepts the signature, ten minutes before the pay deadline, so the button is never a surprise', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkOrder(id, address, 'WITHDRAW', 'MATCHED');

    const res = await screen(id, token);
    expect(res.text).toContain('2286-11-20T17:35:39.000Z');
    expect(res.text).not.toContain('2286-11-20T17:46:39.000Z');
  });

  it('does not promise that only the user can release the escrow, because a dispute a resolver decides can also move it', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkOrder(id, address, 'WITHDRAW', 'MATCHED');

    const res = await screen(id, token);
    expect(res.text).not.toMatch(/only when you confirm/i);
    expect(res.text).toMatch(/dispute/i);
  });

  it('tells the user their own remedy before they lock: the refund route opens if the provider never pays', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkOrder(id, address, 'WITHDRAW', 'MATCHED');

    const res = await screen(id, token);
    expect(res.text).toMatch(/take the usdc back/i);
    expect(res.text).toContain('2286-11-20T18:46:39.000Z');
  });

  it('offers no button once the signing window has closed, and says so, instead of a contract error after the click', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkOrder(id, address, 'WITHDRAW', 'MATCHED', BigInt(Math.floor(Date.now() / 1000) + 300));

    const res = await screen(id, token);
    expect(res.text).toMatch(/signing window .* closed/i);
    expect(res.text).not.toMatch(/sign in my wallet/i);
    expect(res.text).not.toContain('/fund.js');
    expect(res.text).not.toMatch(/nothing was taken/i);
    expect(res.text).toMatch(/if you did not sign/i);
  });


  it('shows the same signing screen and figures at AWAITING_ONCHAIN, which the popup treats as still waiting for the signature', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkOrder(id, address, 'WITHDRAW', 'AWAITING_ONCHAIN');

    const res = await screen(id, token);
    expect(res.text).toMatch(/sign to lock your usdc/i);
    expect(res.text).toContain('<strong>1000</strong> USDC');
    expect(res.text).toContain('<strong>16.000.000</strong> IDR');
  });

  it('while a provider is still being matched, says so, rather than claiming USDC is already moving', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkOrder(id, address, 'WITHDRAW', 'CREATED');

    const res = await screen(id, token);
    expect(res.text).toMatch(/finding a provider/i);
    expect(res.text).not.toMatch(/is being placed in escrow/i);
    expect(res.text).toMatch(/http-equiv="refresh"/i);
  });

  it('a FUNDED withdrawal is never told to send rupiah, and is never shown the provider bank account', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkOrder(id, address, 'WITHDRAW');

    const res = await screen(id, token);
    expect(res.text).not.toMatch(/send your rupiah/i);
    expect(res.text).not.toContain('BCA 999888777');
    expect(res.text).toMatch(/your usdc is in escrow/i);
  });

  it('does not offer the confirm button at FUNDED, the one status the escrow refuses it at', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkOrder(id, address, 'WITHDRAW');

    const res = await screen(id, token);
    expect(res.text).not.toMatch(/i received the rupiah/i);
    expect(res.text).toMatch(/http-equiv="refresh"/i);
    expect(res.text).toMatch(/their claim, not proof/i);
    expect(res.text).toMatch(/can be refunded out of the escrow after/i);
    expect(res.text).toMatch(/open to anyone, including you/i);
    expect(res.text).not.toMatch(/automatic/i);
    expect(res.text).toMatch(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/);
  });

  it('offers the confirm button at FIAT_PAID, which is the only status confirm_and_release accepts', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await linkOrder(id, address, 'WITHDRAW', 'FIAT_PAID');

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
    await linkOrder(id, address, 'TOP_UP', 'FIAT_PAID');

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
    await linkOrder(id, kp.publicKey(), 'TOP_UP');

    const res = await screen(id, token);
    expect(res.text).toMatch(/send your rupiah/i);
    expect(res.text).toContain('BCA 999888777');
  });

  it('the deposit instructions name the attestor grace end, an hour after the pay deadline, even when the confirm window is longer', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await prisma.sep24Transaction.update({ where: { id }, data: { flow: 'TOP_UP' } });
    await linkOrder(id, address, 'TOP_UP', 'FUNDED', 9_999_999_999n, 10_000_007_199n);

    const res = await screen(id, token);
    expect(res.text).toMatch(/send your rupiah/i);
    expect(res.text).toContain('2286-11-20T18:46:39.000Z');
    expect(res.text).not.toContain('2286-11-20T19:46:39.000Z');
  });

  it('the deposit instructions state the USDC to be received, the rate applied and the fee taken, all fixed for this order, so the depositor sees the binding terms before sending irrevocable rupiah', async () => {
    const { id, token, address } = await openedWithdrawal(true);
    await prisma.sep24Transaction.update({ where: { id }, data: { flow: 'TOP_UP' } });
    await linkOrder(id, address, 'TOP_UP', 'FUNDED');

    const res = await screen(id, token);
    expect(res.text).toMatch(/You receive <strong>997<\/strong> USDC/);
    expect(res.text).toMatch(/1 USDC ≈ <strong>16\.000<\/strong> IDR on the <strong>1000<\/strong> USDC escrowed/);
    expect(res.text).toMatch(/fee of <strong>3<\/strong> USDC \(0\.3%\)/);
    expect(res.text).toMatch(/fixed for this order/);
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
        settledStatus: 'RELEASED',
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
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .set('Origin', process.env.ANCHOR_BASE_URL ?? 'http://localhost')
      .send({});

    expect(res.status).toBe(400);
    expect(res.text).not.toMatch(/deposit/i);
  });

  it('refuses the amount step by name while the identity screen is the current one', async () => {
    const { id, token } = await openedWithdrawal(false);
    const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];

    const res = await http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .set('Origin', process.env.ANCHOR_BASE_URL ?? 'http://localhost')
      .send({ fiat_amount: '150000', user_payment_method: 'BNI 1112223334' });

    expect(res.status).toBe(403);
    expect(res.text).toMatch(/not at the point of naming an amount/);
  });

  it('a second identity submit is returned to the screen that is current, not to an error page that could misname the direction', async () => {
    const { id, token } = await openedWithdrawal(true);
    const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];

    const res = await http()
      .post(`/sep24/interactive/${id}/identity`)
      .set('Cookie', cookie)
      .set('Origin', process.env.ANCHOR_BASE_URL ?? 'http://localhost')
      .send({});

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/sep24/interactive/${id}`);

    const landed = await http().get(`/sep24/interactive/${id}`).set('Cookie', cookie);
    expect(landed.status).toBe(200);
    expect(landed.text).not.toMatch(/could not continue/i);
    expect(landed.text).not.toMatch(/deposit status/i);
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
