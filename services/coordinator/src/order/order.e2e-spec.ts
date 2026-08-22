import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { onChainTradeFor } from './test-helpers';
import { PRICE_ADAPTER } from '../rate/rate.module';
import { ThrottlerStorage } from '@nestjs/throttler';
import { OrderService } from './order.service';
import { RateService } from '../rate/rate.service';
import { invalidateAllConfigCaches } from '../config/config-cache';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

function signChallenge(kp: Keypair, message: string): string {
  const payload = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf8'),
    Buffer.from(message, 'utf8'),
  ]);
  const hash = createHash('sha256').update(payload).digest();
  return kp.sign(hash).toString('base64');
}

async function mintJwt(app: INestApplication, kp: Keypair): Promise<string> {
  const ch = await request(app.getHttpServer())
    .post('/auth/challenge')
    .send({ address: kp.publicKey() })
    .expect(201);
  const nonce = ch.body.nonce as string;
  const sig = signChallenge(kp, nonce);
  const res = await request(app.getHttpServer())
    .post('/auth/verify')
    .send({ address: kp.publicKey(), nonce, signature: sig })
    .expect(201);
  return res.body.jwt as string;
}

describe('Order lifecycle (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clearConfigCaches: () => void;
  let stellarMock: jest.Mocked<StellarReadService>;

  const userKp = Keypair.random();
  const lpKp = Keypair.random();
  const adminKp = Keypair.random();

  const fakeAdapter = {
    name: 'fake',
    fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }),
  };

  beforeAll(async () => {
    process.env.ADMIN_ADDRESSES = adminKp.publicKey();

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PRICE_ADAPTER)
      .useValue(fakeAdapter)
      .overrideProvider(StellarReadService)
      .useValue({
        isEligible: jest.fn().mockResolvedValue(true),
        getTradeStatus: jest.fn().mockResolvedValue(null),
        getTradeStatusStrict: jest.fn().mockResolvedValue(null),
        hasUsdcTrustline: jest.fn().mockResolvedValue(true),
      })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .compile();

    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = mod.get(PrismaService);

    clearConfigCaches = () => invalidateAllConfigCaches();
    stellarMock = mod.get(StellarReadService) as jest.Mocked<StellarReadService>;

    await prisma.config.upsert({
      where: { id: 1 },
      update: {
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
      },
      create: {
        id: 1,
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
      },
    });
    await prisma.order.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.lp.deleteMany({});
    const lp = await prisma.lp.upsert({
      where: { stellarAddress: lpKp.publicKey() },
      update: {
        status: 'APPROVED',
        online: true,
        lastHeartbeatAt: new Date(),
        contact: 'lp@e2e.test',
        liquidityProof: 'proof',
        approvedAt: new Date(),
      },
      create: {
        stellarAddress: lpKp.publicKey(),
        status: 'APPROVED',
        online: true,
        lastHeartbeatAt: new Date(),
        contact: 'lp@e2e.test',
        liquidityProof: 'proof',
        approvedAt: new Date(),
      },
    });

    await prisma.paymentMethod.deleteMany({ where: { lpId: lp.id, rail: 'BANK' } });
    await prisma.paymentMethod.create({
      data: {
        lpId: lp.id,
        rail: 'BANK',
        label: 'BCA Order Test',
        details: 'BCA 987654321',
        active: true,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  let userJwt: string;
  let lpJwt: string;
  let withdrawOrderId: string;

  it('user authenticates', async () => {
    userJwt = await mintJwt(app, userKp);
    lpJwt = await mintJwt(app, lpKp);
    expect(typeof userJwt).toBe('string');
  });

  it('GET /orders never exposes payment_instructions', async () => {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    const oRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id, userPaymentMethod: 'BNI 111222333' })
      .expect(201);
    expect(oRes.body.order.status).toBe('MATCHED');

    const listRes = await request(app.getHttpServer())
      .get('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);

    expect(Array.isArray(listRes.body)).toBe(true);
    for (const item of listRes.body as any[]) {
      expect(item.payment_instructions).toBeUndefined();
    }
  });

  it('POST /orders (WITHDRAW) → trade_id present; create_trade_params correct', async () => {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    const res = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id, userPaymentMethod: 'BNI 111222333' })
      .expect(201);

    expect(res.body.order.trade_id).toHaveLength(64);
    expect(res.body.order.status).toBe('MATCHED');
    expect(res.body.order.flow).toBe('WITHDRAW');

    expect(res.body.create_trade_params).toBeDefined();
    expect(res.body.create_trade_params.usdc_provider).toBe(userKp.publicKey());
    expect(res.body.create_trade_params.usdc_recipient).toBe(lpKp.publicKey());
    expect(res.body.create_trade_params.confirmer).toBe(userKp.publicKey());
    expect(res.body.create_trade_params.usdc_amount).toBe('1000000000');
    expect(typeof res.body.create_trade_params.pay_deadline).toBe('number');

    expect(res.body.create_trade_params.platform_wallet).toBeTruthy();

    withdrawOrderId = res.body.order.id;
  });

  it('reusing the same quote → 409', async () => {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id, userPaymentMethod: 'BNI 999' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id, userPaymentMethod: 'BNI 999' })
      .expect(409);
  });

  it('GET /orders/:id — payment_instructions hidden when MATCHED (chain returns null)', async () => {
    const res = await request(app.getHttpServer())
      .get(`/orders/${withdrawOrderId}`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);

    expect(res.body.status).toBe('MATCHED');
    expect(res.body.payment_instructions).toBeUndefined();
  });

  it('GET /orders/:id — chain reports FUNDED from MATCHED → DB advances; LP (fiat payer) sees instructions', async () => {
    stellarMock.getTradeStatus.mockImplementationOnce(async (_c: string, tid: string) =>
      onChainTradeFor(await prisma.order.findUnique({ where: { tradeId: tid } }), 'FUNDED') as any);

    const res = await request(app.getHttpServer())
      .get(`/orders/${withdrawOrderId}`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .expect(200);

    expect(res.body.status).toBe('FUNDED');

    expect(res.body.payment_instructions).toBeDefined();
    expect(res.body.payment_instructions).toBe('BNI 111222333');
  });

  it('GET /orders/:id — user is NOT fiat payer for WITHDRAW → instructions hidden after FUNDED', async () => {
    stellarMock.getTradeStatus.mockImplementationOnce(async (_c: string, tid: string) =>
      onChainTradeFor(await prisma.order.findUnique({ where: { tradeId: tid } }), 'FUNDED') as any);

    const res = await request(app.getHttpServer())
      .get(`/orders/${withdrawOrderId}`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);

    expect(res.body.status).toBe('FUNDED');
    expect(res.body.payment_instructions).toBeUndefined();
  });

  it('POST /orders/:id/cancel → 409 when chain is FUNDED (even if cancel is called before local DB update)', async () => {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    const oRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id, userPaymentMethod: 'BNI 777' })
      .expect(201);
    const freshOrderId = oRes.body.order.id;

    stellarMock.getTradeStatusStrict.mockImplementationOnce(async (_c: string, tid: string) =>
      onChainTradeFor(await prisma.order.findUnique({ where: { tradeId: tid } }), 'FUNDED') as any);

    await request(app.getHttpServer())
      .post(`/orders/${freshOrderId}/cancel`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(409);
  });

  it('cancel while MATCHED (chain null) → 200', async () => {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    const oRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id, userPaymentMethod: 'BCA 001' })
      .expect(201);
    const cId = oRes.body.order.id;

    stellarMock.getTradeStatusStrict.mockResolvedValueOnce(null);

    const cRes = await request(app.getHttpServer())
      .post(`/orders/${cId}/cancel`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);
    expect(cRes.body.status).toBe('CANCELLED');
  });

  it('cancel fails closed (409) when getTradeStatusStrict throws (RPC error)', async () => {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    const oRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id, userPaymentMethod: 'BCA RPC-error' })
      .expect(201);
    const rpcErrorOrderId = oRes.body.order.id;

    stellarMock.getTradeStatusStrict.mockRejectedValueOnce(new Error('RPC timeout'));

    await request(app.getHttpServer())
      .post(`/orders/${rpcErrorOrderId}/cancel`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(409);
  });

  it('TOP_UP: create_trade_params NOT returned to user; LP sees it in /lp/assignments', async () => {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    const oRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)

      .send({ quoteId: qRes.body.quote_id })
      .expect(201);

    expect(oRes.body.order.flow).toBe('TOP_UP');

    expect(oRes.body.create_trade_params).toBeUndefined();

    const topUpOrderId = oRes.body.order.id;

    const assignRes = await request(app.getHttpServer())
      .get('/lp/assignments')
      .set('Authorization', `Bearer ${lpJwt}`)
      .expect(200);

    const entry = (assignRes.body as any[]).find((a: any) => a.order.id === topUpOrderId);
    expect(entry).toBeDefined();
    expect(entry.create_trade_params).toBeDefined();
    expect(entry.create_trade_params.usdc_provider).toBe(lpKp.publicKey());
    expect(entry.create_trade_params.usdc_recipient).toBe(userKp.publicKey());
    expect(entry.create_trade_params.confirmer).toBe(lpKp.publicKey());

    expect(entry.create_trade_params.platform_wallet).toBeTruthy();
  });

  it('TOP_UP: after chain-FUNDED, user (fiat payer) sees LP payment details', async () => {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    const oRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id })
      .expect(201);
    const topUpId = oRes.body.order.id;

    stellarMock.getTradeStatus.mockImplementationOnce(async (_c: string, tid: string) =>
      onChainTradeFor(await prisma.order.findUnique({ where: { tradeId: tid } }), 'FUNDED') as any);

    const res = await request(app.getHttpServer())
      .get(`/orders/${topUpId}`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);

    expect(res.body.status).toBe('FUNDED');

    expect(res.body.payment_instructions).toBe('BCA 987654321');
  });

  it('POST /orders blocked when platform is paused at order time', async () => {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    await prisma.config.update({ where: { id: 1 }, data: { paused: true } });
    clearConfigCaches();

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id, userPaymentMethod: 'BCA 123' })
      .expect(503);

    await prisma.config.update({ where: { id: 1 }, data: { paused: false } });
    clearConfigCaches();
  });

  it('unauthenticated POST /orders → 401', async () => {
    await request(app.getHttpServer())
      .post('/orders')
      .send({ quoteId: 'some-id' })
      .expect(401);
  });

  it('GET /orders/:id for non-existent order → 404', async () => {
    await request(app.getHttpServer())
      .get('/orders/00000000-0000-0000-0000-000000000000')
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(404);
  });

  it('POST /orders with expired quote → 400', async () => {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    await prisma.quote.update({
      where: { id: qRes.body.quote_id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id, userPaymentMethod: 'BCA 999' })
      .expect(400);
  });

  it('WITHDRAW without userPaymentMethod → 400', async () => {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id })
      .expect(400);
  });
});
