import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { bootAuthApp, anchorToken, sessionToken } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';
import { PRICE_ADAPTER } from '../rate/rate.module';
import { StellarReadService } from '../stellar/stellar-read.service';

describe('the withdrawal door, with the switch on', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let saved: string | undefined;

  beforeAll(async () => {
    saved = process.env.SEP24_WITHDRAW_ENABLED;
    process.env.SEP24_WITHDRAW_ENABLED = 'true';
    app = await bootAuthApp((b) =>
      b
        .overrideProvider(PRICE_ADAPTER)
        .useValue({ name: 'fake', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) })
        .overrideProvider(StellarReadService)
        .useValue({
          isEligible: jest.fn().mockResolvedValue(true),
          getStakeInfo: jest.fn().mockResolvedValue({
            staked: '1000000000000',
            unbonding: '0',
            unbond_available_at: 0,
            min_stake: '1',
            eligible: true,
          }),
          getTradeStatus: jest.fn().mockResolvedValue(null),
          getTradeStatusStrict: jest.fn().mockResolvedValue(null),
          hasUsdcTrustline: jest.fn().mockResolvedValue(true),
        }),
    );
    prisma = app.get(PrismaService);

    const lpKp = Keypair.random();
    const lp = await prisma.lp.create({
      data: {
        stellarAddress: lpKp.publicKey(),
        status: 'APPROVED',
        online: true,
        lastHeartbeatAt: new Date(),
        contact: 'lp@withdraw.test',
        liquidityProof: 'proof',
        approvedAt: new Date(),
      },
    });
    await prisma.paymentMethod.create({
      data: { lpId: lp.id, rail: 'BANK', label: 'BCA', details: 'BCA 1', active: true },
    });
  });

  afterAll(async () => {
    if (saved === undefined) delete process.env.SEP24_WITHDRAW_ENABLED;
    else process.env.SEP24_WITHDRAW_ENABLED = saved;
    await app.close();
  });

  const http = () => request(app.getHttpServer());
  const base = process.env.ANCHOR_BASE_URL ?? 'http://localhost';

  async function open(body: Record<string, unknown>) {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    const res = await http()
      .post('/sep24/transactions/withdraw/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send(body);
    return { res, address: kp.publicKey() };
  }

  it('needs a SEP-10 token even with the switch on, and says which token it wants', async () => {
    const res = await http()
      .post('/sep24/transactions/withdraw/interactive')
      .send({ asset_code: 'USDC' })
      .expect(403);
    expect(res.body.message).toMatch(/requires a SEP-10 token/i);
  });

  it('admits a SEP-10 token, which only the opt-in on this route allows, and an app session as every route does', async () => {
    const anchor = Keypair.random();
    await http()
      .post('/sep24/transactions/withdraw/interactive')
      .set('Authorization', `Bearer ${await anchorToken(app, anchor)}`)
      .send({ asset_code: 'USDC' })
      .expect(200);

    const app_ = Keypair.random();
    await http()
      .post('/sep24/transactions/withdraw/interactive')
      .set('Authorization', `Bearer ${await sessionToken(app, app_)}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
  });

  it('advertises withdrawal in /info once the switch is on, so the door and the promise agree', async () => {
    const { body } = await http().get('/sep24/info');
    expect(body.withdraw.USDC.enabled).toBe(true);
  });

  it('records the row as a withdrawal, which is the whole point of the separate door', async () => {
    const { res, address } = await open({ asset_code: 'USDC' });
    expect(res.status).toBe(200);
    expect(res.body.type).toBe('interactive_customer_info_needed');
    const row = await prisma.sep24Transaction.findFirst({ where: { stellarAccount: address } });
    expect(row!.flow).toBe('WITHDRAW');
  });

  it('leaves the deposit door recording deposits, so one flow did not overwrite the other', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const row = await prisma.sep24Transaction.findFirst({
      where: { stellarAccount: kp.publicKey() },
    });
    expect(row!.flow).toBe('TOP_UP');
  });

  it('refuses an asset it does not serve', async () => {
    const { res } = await open({ asset_code: 'BADCODE' });
    expect(res.status).toBe(400);
  });

  it('refuses a withdrawal that names somebody else as the account', async () => {
    const stranger = Keypair.random().publicKey();
    const { res } = await open({ asset_code: 'USDC', account: stranger });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/withdraws from the account its token speaks for/i);
    expect(res.body.message).not.toMatch(/deposit/i);
  });

  async function atAmountStep() {
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
    const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];
    return { id, cookie, address: kp.publicKey() };
  }

  function postAmount(id: string, cookie: string[], body: Record<string, unknown>) {
    return http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .set('Origin', base)
      .send(body);
  }

  it('asks a withdrawing user for the bank account, on the same form as the amount', async () => {
    const { id, cookie } = await atAmountStep();
    const shown = await http().get(`/sep24/interactive/${id}`).set('Cookie', cookie).expect(200);
    expect(shown.text).toContain('name="user_payment_method"');
    expect(shown.text).toMatch(/bank account to pay your rupiah into/i);
  });

  it('does not ask a depositing user for a bank account, because the provider names theirs', async () => {
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
    const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];
    const shown = await http().get(`/sep24/interactive/${id}`).set('Cookie', cookie).expect(200);
    expect(shown.text).not.toContain('name="user_payment_method"');
  });

  it('refuses a withdrawal whose bank account is missing or only whitespace, and creates no order', async () => {
    for (const value of [undefined, '', '   ', '\t\n']) {
      const { id, cookie, address } = await atAmountStep();
      const res = await postAmount(id, cookie, { fiat_amount: '1000000', user_payment_method: value });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.text).toMatch(/bank account this anchor should pay/i);
      expect(await prisma.order.count({ where: { userAddress: address } })).toBe(0);
    }
  });

  it('refuses bank details carrying control characters, which would travel to the provider verbatim', async () => {
    const { id, cookie, address } = await atAmountStep();
    const res = await postAmount(id, cookie, {
      fiat_amount: '1000000',
      user_payment_method: 'BNI 111222333\u0000DROP',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).toMatch(/will not send on/i);
    expect(await prisma.order.count({ where: { userAddress: address } })).toBe(0);
  });

  it('refuses bank details longer than the column will honestly carry', async () => {
    const { id, cookie, address } = await atAmountStep();
    const res = await postAmount(id, cookie, {
      fiat_amount: '1000000',
      user_payment_method: 'B'.repeat(501),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.text).toMatch(/too long/i);
    expect(await prisma.order.count({ where: { userAddress: address } })).toBe(0);
  });

  it('never creates a TOP_UP order from a withdrawal, whatever the amount step goes on to do', async () => {
    const { id, cookie, address } = await atAmountStep();
    const posted = await postAmount(id, cookie, {
      fiat_amount: '1000000',
      user_payment_method: 'BNI 111222333 THE USER',
    });
    expect(posted.status).toBeLessThan(400);

    const orders = await prisma.order.findMany({ where: { userAddress: address } });
    expect(orders).toHaveLength(1);
    expect(orders[0].flow).toBe('WITHDRAW');
    expect(orders[0].userPaymentDetails).toBe('BNI 111222333 THE USER');
  });

  it('carries the bank account through to the order the provider will pay, not somewhere it is dropped', async () => {
    const { id, cookie, address } = await atAmountStep();
    const res = await postAmount(id, cookie, {
      fiat_amount: '1000000',
      user_payment_method: '  BNI 999 SPACED  ',
    });

    expect(res.status).toBeLessThan(400);
    const orders = await prisma.order.findMany({ where: { userAddress: address } });
    expect(orders).toHaveLength(1);
    expect(orders[0].userPaymentDetails).toBe('BNI 999 SPACED');
  });

  it('a deposit at the same step is never refused for the withdrawal reason, so the message discriminates', async () => {
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

    const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];

    const res = await http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .set('Origin', base)
      .send({ fiat_amount: '1000000' });

    expect(String(res.text)).not.toMatch(/will not turn one into a deposit/i);
  });

  it('surfaces the row through the read endpoints as a withdrawal', async () => {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp);
    await http()
      .post('/sep24/transactions/withdraw/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);

    const { body } = await http()
      .get('/sep24/transactions?asset_code=USDC&kind=withdrawal')
      .set('Authorization', `Bearer ${jwt}`)
      .expect(200);
    expect(body.transactions).toHaveLength(1);
    expect(body.transactions[0].kind).toBe('withdrawal');
    expect(body.transactions[0].from).toBe(kp.publicKey());
    expect(body.transactions[0].to).toBeNull();
  });
});
