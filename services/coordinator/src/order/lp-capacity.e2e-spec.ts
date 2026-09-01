import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { PRICE_ADAPTER } from '../rate/rate.module';
import { ThrottlerStorage } from '@nestjs/throttler';
import { invalidateAllConfigCaches } from '../config/config-cache';
import { lpExposure, LP_CAPACITY_LOCK_NAMESPACE } from './lp-exposure';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

const ORDER_BASE_UNITS = 1_000_000_000n;
const STAKED_BASE_UNITS = '1500000000';

function signChallenge(kp: Keypair, message: string): string {
  const payload = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf8'),
    Buffer.from(message, 'utf8'),
  ]);
  return Buffer.from(kp.sign(createHash('sha256').update(payload).digest())).toString('base64');
}

async function mintJwt(app: INestApplication, kp: Keypair): Promise<string> {
  const ch = await request(app.getHttpServer())
    .post('/auth/challenge')
    .send({ address: kp.publicKey() })
    .expect(201);
  const sig = signChallenge(kp, ch.body.nonce as string);
  const res = await request(app.getHttpServer())
    .post('/auth/verify')
    .send({ address: kp.publicKey(), nonce: ch.body.nonce, signature: sig })
    .expect(201);
  return res.body.jwt as string;
}

async function verifiedJwt(app: INestApplication, kp: Keypair): Promise<string> {
  const jwt = await mintJwt(app, kp);
  const prisma = app.get(PrismaService);
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
  return jwt;
}

describe('one provider bond cannot back two trades at once', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const fakeAdapter = { name: 'fake', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) };

  beforeAll(async () => {
    process.env.ADMIN_ADDRESSES = Keypair.random().publicKey();

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PRICE_ADAPTER)
      .useValue(fakeAdapter)
      .overrideProvider(StellarReadService)
      .useValue({
        isEligible: jest.fn().mockResolvedValue(true),
        getTradeStatus: jest.fn().mockResolvedValue(null),
        getTradeStatusStrict: jest.fn().mockResolvedValue(null),
        hasUsdcTrustline: jest.fn().mockResolvedValue(true),
        getStakeInfo: jest.fn().mockResolvedValue({
          staked: STAKED_BASE_UNITS,
          unbonding: '0',
          unbond_available_at: 0,
          min_stake: '1',
          eligible: true,
        }),
      })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .compile();

    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = mod.get(PrismaService);

    const config = {
      spreadBps: 150,
      platformFeeBps: 30,
      lpFeeBps: 120,
      minOrder: 50_000_000n,
      maxOrder: 10_000_000_000n,
      paused: false,
      dailyLimitByTier: { BRONZE: 1000000, SILVER: 1000000, TRUSTED: 1000000, GOLD: 1000000 },
      payWindowSecs: 1800,
      confirmWindowSecs: 1800,
      disputeWindowSecs: 7200,
      platformWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    };
    await prisma.config.upsert({ where: { id: 1 }, update: config, create: { id: 1, ...config } });
    invalidateAllConfigCaches();

  });

  async function seedProviders(count: number): Promise<string[]> {
    await prisma.order.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.lp.deleteMany({});
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const lp = await prisma.lp.create({
        data: {
          stellarAddress: Keypair.random().publicKey(),
          status: 'APPROVED',
          online: true,
          lastHeartbeatAt: new Date(),
          contact: `lp${i}@capacity.test`,
          liquidityProof: 'proof',
          approvedAt: new Date(),
        },
      });
      await prisma.paymentMethod.create({
        data: { lpId: lp.id, rail: 'BANK', label: 'BCA', details: `BCA ${i}`, active: true },
      });
      ids.push(lp.id);
    }
    expect(await prisma.lp.count()).toBe(count);
    return ids;
  }

  async function ungrantedProviderLocks(): Promise<number> {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_locks
       WHERE locktype = 'advisory' AND classid = ${LP_CAPACITY_LOCK_NAMESPACE} AND NOT granted`;
    return rows[0].n;
  }

  afterAll(async () => {
    await app.close();
  });

  async function quoteFor(jwt: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: ORDER_BASE_UNITS.toString() })
      .expect(201);
    return res.body.quote_id as string;
  }

  function placeOrder(jwt: string, quoteId: string) {
    return request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ quoteId, userPaymentMethod: 'BNI 111222333' });
  }

  it('refuses the second of two simultaneous matches that would together exceed the bond', async () => {
    const [lpId] = await seedProviders(1);

    const a = Keypair.random();
    const b = Keypair.random();
    const [jwtA, jwtB] = [await verifiedJwt(app, a), await verifiedJwt(app, b)];
    const [qA, qB] = [await quoteFor(jwtA), await quoteFor(jwtB)];

    const holder = new PrismaService();
    await holder.$connect();
    let release!: () => void;
    const releaseSignal = new Promise<void>((r) => {
      release = r;
    });
    const holding = holder.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${LP_CAPACITY_LOCK_NAMESPACE}, hashtext(${lpId}))`;
        await releaseSignal;
      },
      { timeout: 60_000 },
    );

    const inFlight = [placeOrder(jwtA, qA).then((r) => r.status), placeOrder(jwtB, qB).then((r) => r.status)];

    const deadline = Date.now() + 30_000;
    while ((await ungrantedProviderLocks()) < 2) {
      if (Date.now() > deadline) throw new Error('the two matches never both reached the provider lock');
      await new Promise((r) => setTimeout(r, 25));
    }

    release();
    await holding;
    await holder.$disconnect();

    const results = await Promise.all(inFlight);
    expect({
      accepted: results.filter((x) => x === 201).length,
      refused: results.filter((x) => x === 503).length,
    }).toEqual({ accepted: 1, refused: 1 });

    const exposure = await lpExposure(prisma, lpId, Math.floor(Date.now() / 1000));
    expect(exposure).toBeLessThanOrEqual(BigInt(STAKED_BASE_UNITS));
  }, 90_000);

  it('will not match a provider that has an unstake in flight', async () => {
    await seedProviders(1);
    const stellar = app.get(StellarReadService) as any;
    stellar.getStakeInfo.mockResolvedValueOnce({
      staked: STAKED_BASE_UNITS,
      unbonding: '1',
      unbond_available_at: 0,
      min_stake: '1',
      eligible: true,
    });

    const kp = Keypair.random();
    const jwt = await verifiedJwt(app, kp);
    const quoteId = await quoteFor(jwt);

    await placeOrder(jwt, quoteId).expect(503);
  }, 30_000);

  it('a provider with no room left does not block the ones that still have room', async () => {
    const [saturated] = await seedProviders(2);

    const filler = Keypair.random();
    const fillerJwt = await verifiedJwt(app, filler);
    await prisma.order.create({
      data: {
        tradeId: `${Date.now()}saturate`,
        userAddress: filler.publicKey(),
        personId: (await prisma.person.create({ data: {} })).id,
        lpId: saturated,
        flow: 'WITHDRAW',
        rail: 'BANK',
        usdcAmount: BigInt(STAKED_BASE_UNITS),
        fiatAmount: 1n,
        rateSnapshot: '16000',
        platformFeeBps: 10,
        lpFeeBps: 10,
        platformWallet: 'GPLATFORM',
        status: 'RELEASED',
        settledAt: new Date(),
        postSettleDeadline: BigInt(Math.floor(Date.now() / 1000) + 86_400),
        payDeadline: 0n,
        confirmDeadline: 0n,
        disputeDeadline: 0n,
        expiresAt: new Date(),
      } as any,
    });

    const quoteId = await quoteFor(fillerJwt);
    const res = await placeOrder(fillerJwt, quoteId);

    expect(res.status).toBe(201);
    expect(await lpExposure(prisma, saturated, Math.floor(Date.now() / 1000))).toBe(
      BigInt(STAKED_BASE_UNITS),
    );
  }, 30_000);

  it('accepts a trade that exactly fills the bond, and refuses the next stroop', async () => {
    await seedProviders(1);
    const kp = Keypair.random();
    const jwt = await verifiedJwt(app, kp);

    const exact = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: STAKED_BASE_UNITS })
      .expect(201);
    await placeOrder(jwt, exact.body.quote_id as string).expect(201);

    const second = Keypair.random();
    const secondJwt = await verifiedJwt(app, second);
    await placeOrder(secondJwt, await quoteFor(secondJwt)).expect(503);
  }, 30_000);
});
