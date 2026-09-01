import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { PRICE_ADAPTER } from '../rate/rate.module';
import { ThrottlerStorage } from '@nestjs/throttler';
import { configureHttp } from '../http-setup';
import { sessionToken, anchorToken } from '../auth/auth-test-helpers';
import { onChainTradeFor } from './test-helpers';
import { KYC_PROVIDER } from '../kyc/kyc-provider';
import { StubKycProvider } from '../kyc/stub-kyc-provider';
import { createHmac } from 'crypto';
import { invalidateAllConfigCaches } from '../config/config-cache';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

const REFUSAL = 'identity verification is required before a trade can be opened';

describe('a deposit cannot be opened by an identity the anchor has not verified', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let savedSecret: string | undefined;
  let savedEnvironment: string | undefined;

  beforeAll(async () => {
    savedSecret = process.env.DIDIT_WEBHOOK_SECRET;
    savedEnvironment = process.env.DIDIT_ENVIRONMENT;
    process.env.DIDIT_WEBHOOK_SECRET = 'example-webhook-secret-not-a-real-one';
    process.env.DIDIT_ENVIRONMENT = 'sandbox';

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PRICE_ADAPTER)
      .useValue({ name: 'fake', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) })
      .overrideProvider(StellarReadService)
      .useValue({
        isEligible: jest.fn().mockResolvedValue(true),
        getStakeInfo: jest.fn().mockResolvedValue({
          staked: '1000000000000', unbonding: '0', unbond_available_at: 0, min_stake: '1', eligible: true,
        }),
        getTradeStatus: jest.fn().mockResolvedValue(null),
        getTradeStatusStrict: jest.fn().mockResolvedValue(null),
        hasUsdcTrustline: jest.fn().mockResolvedValue(true),
      })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .overrideProvider(KYC_PROVIDER)
      .useValue(new StubKycProvider())
      .compile();

    app = mod.createNestApplication();
    configureHttp(app);
    await app.init();
    prisma = mod.get(PrismaService);

    const settings = {
      spreadBps: 150, platformFeeBps: 30, lpFeeBps: 120,
      minOrder: 50_000_000n, maxOrder: 10_000_000_000n, paused: false,
      dailyLimitByTier: { BRONZE: 1000000, SILVER: 1000000, TRUSTED: 1000000, GOLD: 1000000 },
      payWindowSecs: 1800, confirmWindowSecs: 1800, disputeWindowSecs: 7200,
      platformWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    };
    await prisma.config.upsert({ where: { id: 1 }, update: settings, create: { id: 1, ...settings } });
    invalidateAllConfigCaches();

    await prisma.order.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.lp.deleteMany({});
    const lpKp = Keypair.random();
    const lp = await prisma.lp.create({
      data: {
        stellarAddress: lpKp.publicKey(), status: 'APPROVED', online: true,
        lastHeartbeatAt: new Date(), contact: 'lp@kyc.test', liquidityProof: 'proof',
        approvedAt: new Date(),
      },
    });
    await prisma.paymentMethod.create({
      data: { lpId: lp.id, rail: 'BANK', label: 'BCA', details: 'BCA 1', active: true },
    });
  });

  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.DIDIT_WEBHOOK_SECRET;
    else process.env.DIDIT_WEBHOOK_SECRET = savedSecret;
    if (savedEnvironment === undefined) delete process.env.DIDIT_ENVIRONMENT;
    else process.env.DIDIT_ENVIRONMENT = savedEnvironment;
    await app.close();
  });

  async function aDepositQuote() {
    const kp = Keypair.random();
    const jwt = await sessionToken(app, kp);
    const q = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);
    return { jwt, quoteId: q.body.quote_id as string, userAddress: kp.publicKey() };
  }

  async function personOf(userAddress: string): Promise<string> {
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: userAddress } });
    return link!.personId;
  }

  async function accept(userAddress: string, extra: Record<string, unknown> = {}) {
    await prisma.kycVerification.create({
      data: {
        customerRef: userAddress,
        personId: await personOf(userAddress),
        status: 'ACCEPTED',
        screenedAt: new Date(),
        verifiedAt: new Date(),
        ...extra,
      },
    });
  }

  it('refuses a deposit for an identity that was never verified', async () => {
    const before = await prisma.order.count();
    const { jwt, quoteId } = await aDepositQuote();
    const res = await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`).send({ quoteId });

    expect(res.status).toBe(403);
    expect(res.body.message).toBe(REFUSAL);
    expect(await prisma.order.count()).toBe(before);
  });

  it('opens it once the identity is accepted and screened', async () => {
    const { jwt, quoteId, userAddress } = await aDepositQuote();
    await accept(userAddress);
    await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`).send({ quoteId }).expect(201);
  });

  it('refuses an accepted identity that no sanctions screening ever touched', async () => {
    const { jwt, quoteId, userAddress } = await aDepositQuote();
    await prisma.kycVerification.create({
      data: {
        customerRef: userAddress,
        personId: await personOf(userAddress),
        status: 'ACCEPTED',
        verifiedAt: new Date(),
      },
    });
    const res = await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`).send({ quoteId });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe(REFUSAL);
  });

  it('refuses an identity the screening rejected, and says nothing about why', async () => {
    const { jwt, quoteId, userAddress } = await aDepositQuote();
    await prisma.kycVerification.create({
      data: {
        customerRef: userAddress,
        personId: await personOf(userAddress),
        status: 'REJECTED',
        screenedAt: new Date(),
        rejectionReason: 'sanctions list match',
      },
    });
    const res = await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`).send({ quoteId });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe(REFUSAL);
    expect(JSON.stringify(res.body)).not.toContain('sanctions');
  });

  it('still refuses when the verification is withdrawn after the first read', async () => {
    const { jwt, quoteId, userAddress } = await aDepositQuote();
    await accept(userAddress);

    const stellar = app.get(StellarReadService) as any;
    const original = stellar.hasUsdcTrustline;
    stellar.hasUsdcTrustline = jest.fn(async () => {
      await prisma.kycVerification.deleteMany({ where: { customerRef: userAddress } });
      return true;
    });

    const before = await prisma.order.count();
    const res = await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`).send({ quoteId });
    stellar.hasUsdcTrustline = original;

    expect(res.status).toBe(403);
    expect(await prisma.order.count()).toBe(before);
  });

  it('gates a withdrawal too, because an off-ramp is the direction AML cares about most', async () => {
    const kp = Keypair.random();
    const jwt = await sessionToken(app, kp);
    const before = await prisma.order.count();
    const q = await request(app.getHttpServer())
      .post('/quotes').set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`)
      .send({ quoteId: q.body.quote_id, userPaymentMethod: 'BNI 111222333' })
      .expect(403);

    expect(res.body.message).toBe(REFUSAL);
    expect(await prisma.order.count()).toBe(before);
  });

  it('refuses a withdrawal whose verification is withdrawn after the first read, which only the check inside the transaction can catch', async () => {
    const kp = Keypair.random();
    const jwt = await sessionToken(app, kp);
    const userAddress = kp.publicKey();
    const q = await request(app.getHttpServer())
      .post('/quotes').set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);
    await accept(userAddress);

    const stellar = app.get(StellarReadService) as any;
    const original = stellar.hasUsdcTrustline;
    stellar.hasUsdcTrustline = jest.fn(async () => {
      await prisma.kycVerification.deleteMany({ where: { customerRef: userAddress } });
      return true;
    });

    const before = await prisma.order.count();
    const res = await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`)
      .send({ quoteId: q.body.quote_id, userPaymentMethod: 'BNI 111222333' });
    stellar.hasUsdcTrustline = original;

    expect(res.status).toBe(403);
    expect(await prisma.order.count()).toBe(before);
  });

  it('says nothing about deposits when it refuses a withdrawal, because it once did', async () => {
    const kp = Keypair.random();
    const jwt = await sessionToken(app, kp);
    const q = await request(app.getHttpServer())
      .post('/quotes').set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);
    const res = await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`)
      .send({ quoteId: q.body.quote_id, userPaymentMethod: 'BNI 111222333' })
      .expect(403);

    expect(res.body.message).not.toMatch(/deposit/i);
  });

  it('a customer verified by a delivery the anchor trusted can then open a deposit', async () => {
    const kp = Keypair.random();
    const anchor = await anchorToken(app, kp);
    await request(app.getHttpServer())
      .put('/customer')
      .set('Authorization', `Bearer ${anchor}`)
      .send({
        first_name: 'Dewi', last_name: 'Lestari', email_address: 'dewi@example.com',
        id_type: 'id_card', id_country_code: 'IDN',
      })
      .expect(202);

    const body = JSON.stringify({
      event_id: 'gate-proof',
      timestamp: Math.floor(Date.now() / 1000),
      session_id: '7b1e0c2a-4f6d-4a1b-9c33-8ad5f0e21b47',
      status: 'Approved',
      vendor_data: kp.publicKey(),
      environment: 'sandbox',
      decision: { aml_screenings: [{ status: 'Approved', total_hits: 0, hits: [], warnings: [] }] },
    });
    await request(app.getHttpServer())
      .post('/webhooks/didit')
      .set('content-type', 'application/json')
      .set('x-signature', createHmac('sha256', process.env.DIDIT_WEBHOOK_SECRET!).update(Buffer.from(body, 'utf8')).digest('hex'))
      .set('x-timestamp', String(Math.floor(Date.now() / 1000)))
      .send(body)
      .expect(200);

    const jwt = await sessionToken(app, kp);
    const q = await request(app.getHttpServer())
      .post('/quotes').set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`)
      .send({ quoteId: q.body.quote_id })
      .expect(201);
  }, 30_000);

  it('closes on a person refused anywhere, even where they had already been accepted', async () => {
    const { jwt, quoteId, userAddress } = await aDepositQuote();
    await accept(userAddress);

    const person = await prisma.walletLink.findUnique({
      where: { stellarAddress: userAddress },
    });
    await prisma.kycVerification.create({
      data: {
        customerRef: `${userAddress}:4242`,
        personId: person!.personId,
        status: 'REJECTED',
        screenedAt: new Date(),
      },
    });

    const before = await prisma.order.count();
    const res = await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`).send({ quoteId });
    expect(res.status).toBe(403);
    expect(res.body.message).toBe(REFUSAL);
    expect(await prisma.order.count()).toBe(before);
  });

  it('stops revealing where to send money once the verdict behind it is gone', async () => {
    const { jwt, quoteId, userAddress } = await aDepositQuote();
    await accept(userAddress);
    const created = await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`).send({ quoteId }).expect(201);

    const orderId = created.body.order.id as string;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    const stellar = app.get(StellarReadService) as any;
    stellar.getTradeStatus = jest.fn(async () => onChainTradeFor(order, 'FUNDED'));

    const shown = await request(app.getHttpServer())
      .get(`/orders/${orderId}`).set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(shown.body.payment_instructions).toBeDefined();

    await prisma.kycVerification.deleteMany({ where: { customerRef: userAddress } });

    const withheld = await request(app.getHttpServer())
      .get(`/orders/${orderId}`).set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(withheld.body.payment_instructions).toBeUndefined();
    expect(withheld.body.payment_instructions_withheld).toBe('kyc_required');
  }, 30_000);

  it.each([
    [
      'the screening that backed it turns out never to have run',
      async (userAddress: string) =>
        prisma.kycVerification.update({
          where: { customerRef: userAddress },
          data: { screenedAt: null },
        }),
    ],
    [
      'a refusal lands against the person under another memo',
      async (userAddress: string) =>
        prisma.kycVerification.create({
          data: {
            customerRef: `${userAddress}:9009`,
            personId: await personOf(userAddress),
            status: 'REJECTED',
            screenedAt: new Date(),
          },
        }),
    ],
  ])('stops revealing where to send money when %s', async (_name, revoke) => {
    const { jwt, quoteId, userAddress } = await aDepositQuote();
    await accept(userAddress);
    const created = await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`).send({ quoteId }).expect(201);

    const orderId = created.body.order.id as string;
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    const stellar = app.get(StellarReadService) as any;
    stellar.getTradeStatus = jest.fn(async () => onChainTradeFor(order, 'FUNDED'));

    const shown = await request(app.getHttpServer())
      .get(`/orders/${orderId}`).set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(shown.body.payment_instructions).toBeDefined();

    await revoke(userAddress);

    const withheld = await request(app.getHttpServer())
      .get(`/orders/${orderId}`).set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(withheld.body.payment_instructions).toBeUndefined();
    expect(withheld.body.payment_instructions_withheld).toBe('kyc_required');
  }, 30_000);

  it('says nothing about withholding on an order that simply is not funded yet', async () => {
    const { jwt, quoteId, userAddress } = await aDepositQuote();
    await accept(userAddress);
    const created = await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`).send({ quoteId }).expect(201);

    const res = await request(app.getHttpServer())
      .get(`/orders/${created.body.order.id}`).set('Authorization', `Bearer ${jwt}`).expect(200);
    expect(res.body.payment_instructions).toBeUndefined();
    expect(res.body.payment_instructions_withheld).toBeUndefined();
  }, 30_000);

  it('no second creator of an Order row has appeared', () => {
    const src = readFileSync(path.resolve(__dirname, 'order.service.ts'), 'utf8');
    expect(src.match(/\.order\.create\(/g) ?? []).toHaveLength(2);
    const all = execSync(
      "grep -rl '\\.order\\.create(' src --include=*.ts --exclude-dir=generated",
    )
      .toString()
      .split('\n')
      .filter((l) => l && !/\.(e2e-)?spec\.ts$/.test(l));
    expect(all).toEqual(['src/order/order.service.ts']);
  });
});
