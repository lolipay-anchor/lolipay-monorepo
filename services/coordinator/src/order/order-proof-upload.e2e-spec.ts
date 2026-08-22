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
import { ObjectStorageService } from '../storage/object-storage.service';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0)]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 0),
]);

const OVERSIZE_JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(6 * 1024 * 1024, 0)]);

function signChallenge(kp: Keypair, message: string): string {
  const payload = Buffer.concat([Buffer.from('Stellar Signed Message:\n', 'utf8'), Buffer.from(message, 'utf8')]);
  const hash = createHash('sha256').update(payload).digest();
  return kp.sign(hash).toString('base64');
}

async function mintJwt(app: INestApplication, kp: Keypair): Promise<string> {
  const ch = await request(app.getHttpServer()).post('/auth/challenge').send({ address: kp.publicKey() }).expect(201);
  const nonce = ch.body.nonce as string;
  const sig = signChallenge(kp, nonce);
  const res = await request(app.getHttpServer())
    .post('/auth/verify')
    .send({ address: kp.publicKey(), nonce, signature: sig })
    .expect(201);
  return res.body.jwt as string;
}

describe('Payment proof + dispute evidence uploads (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let stellarMock: jest.Mocked<StellarReadService>;
  let storage: ObjectStorageService;

  const userKp = Keypair.random();
  const lpKp = Keypair.random();
  const adminKp = Keypair.random();
  const strangerKp = Keypair.random();

  const fakeAdapter = { name: 'fake', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) };

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
        buildMarkFiatPaidTx: jest.fn().mockResolvedValue({ xdr: 'mark-paid-xdr', networkPassphrase: 'Test SDF Network ; September 2015' }),
        buildRaiseDisputeTx: jest.fn().mockResolvedValue({ xdr: 'raise-dispute-xdr', networkPassphrase: 'Test SDF Network ; September 2015' }),
      })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .compile();

    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = mod.get(PrismaService);
    stellarMock = mod.get(StellarReadService) as jest.Mocked<StellarReadService>;
    storage = mod.get(ObjectStorageService);

    await storage.ensureBucket();

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
        postSettleDisputeWindowSecs: 3600,
        requireProof: true,
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
        postSettleDisputeWindowSecs: 3600,
        requireProof: true,
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
      data: { lpId: lp.id, rail: 'BANK', label: 'BCA Proof Test', details: 'BCA 555555', active: true },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  let userJwt: string;
  let lpJwt: string;
  let strangerJwt: string;
  let adminJwt: string;

  it('all parties authenticate', async () => {
    userJwt = await mintJwt(app, userKp);
    lpJwt = await mintJwt(app, lpKp);
    strangerJwt = await mintJwt(app, strangerKp);
    adminJwt = await mintJwt(app, adminKp);
  });

  async function createFundedWithdrawOrder(): Promise<string> {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);
    const oRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id, userPaymentMethod: 'BNI proof-test' })
      .expect(201);
    const orderId = oRes.body.order.id as string;

    stellarMock.getTradeStatus.mockImplementationOnce(async (_c: string, tid: string) =>
      onChainTradeFor(await prisma.order.findUnique({ where: { tradeId: tid } }), 'FUNDED') as any);
    await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);

    return orderId;
  }

  it('POST /orders/:id/proof on a TOP_UP order → 400 (the user, not the LP, pays fiat)', async () => {
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
    const topUpId = oRes.body.order.id as string;

    await request(app.getHttpServer())
      .post(`/orders/${topUpId}/proof`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .attach('file', JPG, { filename: 'proof.jpg', contentType: 'image/jpeg' })
      .expect(400);
  });

  it('POST /orders/:id/proof — wrong party (the user, not the LP) → 403', async () => {
    const orderId = await createFundedWithdrawOrder();
    await request(app.getHttpServer())
      .post(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${userJwt}`)
      .attach('file', JPG, { filename: 'proof.jpg', contentType: 'image/jpeg' })
      .expect(403);
  });

  it('POST /orders/:id/proof — a stranger (not user, not LP) → 403', async () => {
    const orderId = await createFundedWithdrawOrder();
    await request(app.getHttpServer())
      .post(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${strangerJwt}`)
      .attach('file', JPG, { filename: 'proof.jpg', contentType: 'image/jpeg' })
      .expect(403);
  });

  it('POST /orders/:id/proof — wrong status (still MATCHED, not FUNDED) → 409', async () => {
    const qRes = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ flow: 'WITHDRAW', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);
    const oRes = await request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ quoteId: qRes.body.quote_id, userPaymentMethod: 'BNI still-matched' })
      .expect(201);

    await request(app.getHttpServer())
      .post(`/orders/${oRes.body.order.id}/proof`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .attach('file', JPG, { filename: 'proof.jpg', contentType: 'image/jpeg' })
      .expect(409);
  });

  it('POST /orders/:id/proof — PNG bytes declared as image/jpeg → 400 (Content-Type not trusted)', async () => {
    const orderId = await createFundedWithdrawOrder();
    await request(app.getHttpServer())
      .post(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .attach('file', PNG, { filename: 'sneaky.jpg', contentType: 'image/jpeg' })
      .expect(400);
  });

  it('POST /orders/:id/proof — a flood of text fields is refused before the handler runs', async () => {
    const orderId = await createFundedWithdrawOrder();
    const req = request(app.getHttpServer())
      .post(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .attach('file', JPG, { filename: 'p.jpg', contentType: 'image/jpeg' });

    for (let i = 0; i < 200; i++) req.field(`junk${i}`, 'x');

    const res = await req;
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('POST /orders/:id/proof — file over 5MB → 413', async () => {
    const orderId = await createFundedWithdrawOrder();
    await request(app.getHttpServer())
      .post(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .attach('file', OVERSIZE_JPG, { filename: 'huge.jpg', contentType: 'image/jpeg' })
      .expect(413);
  });

  it('GET /orders/:id/tx/mark-paid — requireProof=true, no proof yet → 400', async () => {
    const orderId = await createFundedWithdrawOrder();
    await request(app.getHttpServer())
      .get(`/orders/${orderId}/tx/mark-paid`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .expect(400);
  });

  it('POST /orders/:id/proof — valid jpg, correct LP, FUNDED → 200 + proof_url set; then GET streams it back to user/LP/admin, 403 for a stranger', async () => {
    const orderId = await createFundedWithdrawOrder();

    const uploadRes = await request(app.getHttpServer())
      .post(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .attach('file', JPG, { filename: 'proof.jpg', contentType: 'image/jpeg' })
      .expect(200);
    expect(uploadRes.body.proof_url).toMatch(/^proofs\/[0-9a-f-]{36}\.jpg$/);

    const userGet = await request(app.getHttpServer())
      .get(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);
    expect(userGet.headers['content-type']).toBe('image/jpeg');
    expect(Buffer.compare(userGet.body as Buffer, JPG)).toBe(0);

    expect(userGet.headers['x-content-type-options']).toBe('nosniff');
    expect(userGet.headers['content-disposition']).toBe(`attachment; filename="proof-${orderId}.jpg"`);
    expect(userGet.headers['content-security-policy']).toBe("default-src 'none'; sandbox");

    await request(app.getHttpServer())
      .get(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${strangerJwt}`)
      .expect(403);

    await request(app.getHttpServer())
      .get(`/orders/${orderId}/tx/mark-paid`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .expect(200);
  });

  it('POST /orders/:id/proof — reupload replaces the old object in place: old key gone from MinIO, new one served', async () => {
    const orderId = await createFundedWithdrawOrder();

    const firstUpload = await request(app.getHttpServer())
      .post(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .attach('file', JPG, { filename: 'proof1.jpg', contentType: 'image/jpeg' })
      .expect(200);
    const firstPath = firstUpload.body.proof_url as string;
    await expect(storage.statObject(firstPath)).resolves.toBe(true);

    const secondUpload = await request(app.getHttpServer())
      .post(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .attach('file', PNG, { filename: 'proof2.png', contentType: 'image/png' })
      .expect(200);
    const secondPath = secondUpload.body.proof_url as string;
    expect(secondPath).not.toBe(firstPath);

    await expect(storage.statObject(firstPath)).resolves.toBe(false);
    const getRes = await request(app.getHttpServer())
      .get(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);
    expect(getRes.headers['content-type']).toBe('image/png');
    expect(Buffer.compare(getRes.body as Buffer, PNG)).toBe(0);
  });

  it('GET /orders/:id/proof — no proof uploaded yet → 404', async () => {
    const orderId = await createFundedWithdrawOrder();
    await request(app.getHttpServer())
      .get(`/orders/${orderId}/proof`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(404);
  });

  it('requireProof=false → mark-paid succeeds even without a proof upload', async () => {
    await prisma.config.update({ where: { id: 1 }, data: { requireProof: false } });

    (app.get(OrderService) as any).configCache = null;
    try {
      const orderId = await createFundedWithdrawOrder();
      await request(app.getHttpServer())
        .get(`/orders/${orderId}/tx/mark-paid`)
        .set('Authorization', `Bearer ${lpJwt}`)
        .expect(200);
    } finally {
      await prisma.config.update({ where: { id: 1 }, data: { requireProof: true } });
      (app.get(OrderService) as any).configCache = null;
    }
  });

  it('POST /orders/:id/dispute-evidence — not disputable yet (still FUNDED) → 409', async () => {
    const orderId = await createFundedWithdrawOrder();
    await request(app.getHttpServer())
      .post(`/orders/${orderId}/dispute-evidence`)
      .set('Authorization', `Bearer ${userJwt}`)
      .attach('file', JPG, { filename: 'evidence.jpg', contentType: 'image/jpeg' })
      .expect(409);
  });

  it('POST /orders/:id/dispute-evidence — a stranger (not user, not LP) → 403', async () => {
    const orderId = await createFundedWithdrawOrder();
    await request(app.getHttpServer())
      .post(`/orders/${orderId}/dispute-evidence`)
      .set('Authorization', `Bearer ${strangerJwt}`)
      .attach('file', JPG, { filename: 'evidence.jpg', contentType: 'image/jpeg' })
      .expect(403);
  });

  it('POST /orders/:id/dispute-evidence — FIAT_PAID → 200 with an evidence_url; does not change order status', async () => {
    const orderId = await createFundedWithdrawOrder();
    stellarMock.getTradeStatus.mockImplementationOnce(async (_c: string, tid: string) =>
      onChainTradeFor(await prisma.order.findUnique({ where: { tradeId: tid } }), 'FIAT_PAID') as any);
    await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);

    const res = await request(app.getHttpServer())
      .post(`/orders/${orderId}/dispute-evidence`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .attach('file', JPG, { filename: 'evidence.jpg', contentType: 'image/jpeg' })
      .expect(200);

    expect(res.body.evidence_url).toBe(`evidence/${orderId}-lp.jpg`);

    const after = await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);
    expect(after.body.status).toBe('FIAT_PAID');
  });

  it('POST /orders/:id/dispute-evidence — RELEASED, past the post-settle window → 409 (window boundary)', async () => {
    const orderId = await createFundedWithdrawOrder();
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'RELEASED', settledAt: new Date(Date.now() - 999 * 60 * 60 * 1000) },
    });

    await request(app.getHttpServer())
      .post(`/orders/${orderId}/dispute-evidence`)
      .set('Authorization', `Bearer ${userJwt}`)
      .attach('file', JPG, { filename: 'evidence.jpg', contentType: 'image/jpeg' })
      .expect(409);
  });

  it('POST /orders/:id/dispute-evidence — RELEASED, WITHIN the post-settle window → 200', async () => {
    const orderId = await createFundedWithdrawOrder();
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'RELEASED', settledAt: new Date(Date.now() - 60_000) },
    });

    const res = await request(app.getHttpServer())
      .post(`/orders/${orderId}/dispute-evidence`)
      .set('Authorization', `Bearer ${userJwt}`)
      .attach('file', JPG, { filename: 'evidence.jpg', contentType: 'image/jpeg' })
      .expect(200);
    expect(res.body.evidence_url).toBe(`evidence/${orderId}-user.jpg`);
  });

  it('POST /orders/:id/dispute-evidence — reupload by the same party overwrites the same path (no growth), user/lp stay separate', async () => {
    const orderId = await createFundedWithdrawOrder();
    stellarMock.getTradeStatus.mockImplementationOnce(async (_c: string, tid: string) =>
      onChainTradeFor(await prisma.order.findUnique({ where: { tradeId: tid } }), 'FIAT_PAID') as any);
    await request(app.getHttpServer())
      .get(`/orders/${orderId}`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(200);

    const first = await request(app.getHttpServer())
      .post(`/orders/${orderId}/dispute-evidence`)
      .set('Authorization', `Bearer ${userJwt}`)
      .attach('file', JPG, { filename: 'evidence1.jpg', contentType: 'image/jpeg' })
      .expect(200);
    const second = await request(app.getHttpServer())
      .post(`/orders/${orderId}/dispute-evidence`)
      .set('Authorization', `Bearer ${userJwt}`)
      .attach('file', JPG, { filename: 'evidence2.jpg', contentType: 'image/jpeg' })
      .expect(200);

    expect(first.body.evidence_url).toBe(`evidence/${orderId}-user.jpg`);
    expect(second.body.evidence_url).toBe(first.body.evidence_url);

    const lpRes = await request(app.getHttpServer())
      .post(`/orders/${orderId}/dispute-evidence`)
      .set('Authorization', `Bearer ${lpJwt}`)
      .attach('file', JPG, { filename: 'lp-evidence.jpg', contentType: 'image/jpeg' })
      .expect(200);
    expect(lpRes.body.evidence_url).toBe(`evidence/${orderId}-lp.jpg`);

    await expect(storage.statObject(`evidence/${orderId}-user.jpg`)).resolves.toBe(true);
    await expect(storage.statObject(`evidence/${orderId}-lp.jpg`)).resolves.toBe(true);
  });
});
