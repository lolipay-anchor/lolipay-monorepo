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
import { lpExposure } from './lp-exposure';

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

describe('one provider bond cannot back two trades at once', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let lpId: string;

  const lpKp = Keypair.random();
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

    await prisma.order.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.lp.deleteMany({});

    const lp = await prisma.lp.create({
      data: {
        stellarAddress: lpKp.publicKey(),
        status: 'APPROVED',
        online: true,
        lastHeartbeatAt: new Date(),
        contact: 'lp@capacity.test',
        liquidityProof: 'proof',
        approvedAt: new Date(),
      },
    });
    lpId = lp.id;
    await prisma.paymentMethod.create({
      data: { lpId: lp.id, rail: 'BANK', label: 'BCA', details: 'BCA 1', active: true },
    });
  });

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
    for (let round = 0; round < 3; round++) {
      await prisma.order.deleteMany({});

      const a = Keypair.random();
      const b = Keypair.random();
      const [jwtA, jwtB] = [await mintJwt(app, a), await mintJwt(app, b)];
      const [qA, qB] = [await quoteFor(jwtA), await quoteFor(jwtB)];

      const results = await Promise.all([
        placeOrder(jwtA, qA).then((r) => r.status),
        placeOrder(jwtB, qB).then((r) => r.status),
      ]);

      const accepted = results.filter((s) => s === 201);
      const refused = results.filter((s) => s === 503);

      expect({ round, accepted: accepted.length, refused: refused.length, results }).toEqual({
        round,
        accepted: 1,
        refused: 1,
        results: expect.any(Array),
      });

      const exposure = await lpExposure(prisma, lpId, Math.floor(Date.now() / 1000));
      expect(exposure).toBeLessThanOrEqual(BigInt(STAKED_BASE_UNITS));
    }
  }, 60_000);

  it('will not match a provider that has an unstake in flight', async () => {
    await prisma.order.deleteMany({});
    const stellar = app.get(StellarReadService) as any;
    stellar.getStakeInfo.mockResolvedValueOnce({
      staked: STAKED_BASE_UNITS,
      unbonding: '1',
      unbond_available_at: 0,
      min_stake: '1',
      eligible: true,
    });

    const kp = Keypair.random();
    const jwt = await mintJwt(app, kp);
    const quoteId = await quoteFor(jwt);

    await placeOrder(jwt, quoteId).expect(503);
  }, 30_000);
});
