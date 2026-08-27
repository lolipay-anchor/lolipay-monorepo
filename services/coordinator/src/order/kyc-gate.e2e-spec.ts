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
import { invalidateAllConfigCaches } from '../config/config-cache';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

const REFUSAL = 'identity verification is required before a deposit can be opened';

describe('a deposit cannot be opened by an identity the anchor has not verified', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let savedStubScreens: string | undefined;

  beforeAll(async () => {
    savedStubScreens = process.env.KYC_STUB_SCREENS;
    process.env.KYC_STUB_SCREENS = 'true';

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
    if (savedStubScreens === undefined) delete process.env.KYC_STUB_SCREENS;
    else process.env.KYC_STUB_SCREENS = savedStubScreens;
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

  async function accept(userAddress: string, extra: Record<string, unknown> = {}) {
    await prisma.kycVerification.create({
      data: {
        customerRef: userAddress,
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
      data: { customerRef: userAddress, status: 'ACCEPTED', verifiedAt: new Date() },
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
        customerRef: userAddress, status: 'REJECTED', screenedAt: new Date(),
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

  it('does not gate a withdrawal, which the statement of work excludes', async () => {
    const kp = Keypair.random();
    const jwt = await sessionToken(app, kp);
    const q = await request(app.getHttpServer())
      .post('/quotes').set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);
    await request(app.getHttpServer())
      .post('/orders').set('Authorization', `Bearer ${jwt}`)
      .send({ quoteId: q.body.quote_id, userPaymentMethod: 'BNI 111222333' })
      .expect(201);
  });

  it('a customer who registers through the anchor door can then open a deposit, on a stack permitted to pretend it screened', async () => {
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
