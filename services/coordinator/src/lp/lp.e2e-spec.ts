import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { ThrottlerStorage } from '@nestjs/throttler';
import { StellarReadService } from '../stellar/stellar-read.service';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

function signChallenge(kp: Keypair, message: string): string {
  const payload = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf8'),
    Buffer.from(message, 'utf8'),
  ]);
  const hash = createHash('sha256').update(payload).digest();
  return Buffer.from(kp.sign(hash)).toString('base64');
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

describe('LP registry + admin actions (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const adminKp = Keypair.random();
  const lpKp = Keypair.random();
  const userKp = Keypair.random();

  beforeAll(async () => {
    process.env.ADMIN_ADDRESSES = adminKp.publicKey();

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .compile();

    app = mod.createNestApplication();

    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();

    prisma = mod.get(PrismaService);

    jest.spyOn(mod.get(StellarReadService), 'hasUsdcTrustline').mockResolvedValue(true);
    jest.spyOn(mod.get(StellarReadService), 'readEscrowPlatformDefaults').mockResolvedValue({ platformFeeBps: 30, platformWallet: Keypair.random().publicKey() });

    await prisma.config.upsert({
      where: { id: 1 },
      update: { platformFeeBps: 30, lpFeeBps: 120, paused: false },
      create: {
        id: 1,
        spreadBps: 150,
        platformFeeBps: 30,
        lpFeeBps: 120,
        minOrder: 50_000_000n,
        maxOrder: 10_000_000_000n,
        paused: false,
        platformWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
    });

    await prisma.lp.deleteMany({
      where: { stellarAddress: { in: [lpKp.publicKey(), adminKp.publicKey(), userKp.publicKey()] } },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  let lpId: string;
  let lpJwt: string;
  let userJwt: string;
  let adminJwt: string;

  it('LP wallet applies → 201 status PENDING', async () => {
    lpJwt = await mintJwt(app, lpKp);
    const res = await request(app.getHttpServer())
      .post('/lp/apply')
      .set('Authorization', `Bearer ${lpJwt}`)
      .send({ contact: 'lp@test.com', liquidityProof: 'proof-of-liquidity' })
      .expect(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.stellarAddress).toBe(lpKp.publicKey());
    lpId = res.body.id;
  });

  it('unauthenticated apply → 401', async () => {
    await request(app.getHttpServer())
      .post('/lp/apply')
      .send({ contact: 'anon@test.com', liquidityProof: 'proof' })
      .expect(401);
  });

  it('LP can fetch GET /lp/me → includes paymentMethods array', async () => {
    const res = await request(app.getHttpServer())
      .get('/lp/me')
      .set('Authorization', `Bearer ${lpJwt}`)
      .expect(200);
    expect(res.body.stellarAddress).toBe(lpKp.publicKey());
    expect(Array.isArray(res.body.paymentMethods)).toBe(true);
  });

  it('regular user JWT calls POST /admin/lps/:id/approve → 403', async () => {
    userJwt = await mintJwt(app, userKp);
    await request(app.getHttpServer())
      .post(`/admin/lps/${lpId}/approve`)
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(403);
  });

  it('admin approves LP → 200, status APPROVED', async () => {
    adminJwt = await mintJwt(app, adminKp);
    const res = await request(app.getHttpServer())
      .post(`/admin/lps/${lpId}/approve`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ note: 'Looks good' })
      .expect(200);
    expect(res.body.status).toBe('APPROVED');
  });

  it('GET /admin/lps?status=APPROVED includes approved LP', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/lps?status=APPROVED')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    const found = (res.body as any[]).find((l: any) => l.id === lpId);
    expect(found).toBeDefined();
    expect(found.status).toBe('APPROVED');
  });

  it('admin suspends LP → 200, status SUSPENDED', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/lps/${lpId}/suspend`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ note: 'Suspended for review' })
      .expect(200);
    expect(res.body.status).toBe('SUSPENDED');
  });

  it('a SUSPENDED provider cannot clear its own sanction by re-applying', async () => {
    await request(app.getHttpServer())
      .post(`/admin/lps/${lpId}/suspend`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ note: 'took fiat, never delivered' })
      .expect(200);

    const freshLpJwt = await mintJwt(app, lpKp);
    await request(app.getHttpServer())
      .post('/lp/apply')
      .set('Authorization', `Bearer ${freshLpJwt}`)
      .send({ contact: 'sneaky@test.com', liquidityProof: 'proof' })
      .expect(409);

    const row = await prisma.lp.findUnique({ where: { id: lpId } });
    expect(row?.status).toBe('SUSPENDED');
    expect(row?.approvalNote).toBe('took fiat, never delivered');
  });

  it('the administrator note is never returned to the provider', async () => {
    const freshLpJwt = await mintJwt(app, lpKp);
    const res = await request(app.getHttpServer())
      .get('/lp/me')
      .set('Authorization', `Bearer ${freshLpJwt}`)
      .expect(200);

    expect(res.body.status).toBe('SUSPENDED');
    expect(res.body).not.toHaveProperty('approvalNote');
  });

  it('every administrator mutation leaves an audit row naming the actor', async () => {
    const rows = await prisma.adminAudit.findMany({
      where: { targetType: 'Lp', targetId: lpId },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.actorAddress === adminKp.publicKey())).toBe(true);
    expect(rows.some((r) => r.action === 'lp.setStatus')).toBe(true);
  });

  it('admin revokes LP → 200, status REVOKED', async () => {
    const res = await request(app.getHttpServer())
      .post(`/admin/lps/${lpId}/revoke`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ note: 'Revoked' })
      .expect(200);
    expect(res.body.status).toBe('REVOKED');
  });

  it('LP adds payment method → 201', async () => {
    await request(app.getHttpServer())
      .post(`/admin/lps/${lpId}/approve`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ note: 'Re-approved' });

    const freshLpJwt = await mintJwt(app, lpKp);
    const res = await request(app.getHttpServer())
      .post('/lp/payment-methods')
      .set('Authorization', `Bearer ${freshLpJwt}`)
      .send({ rail: 'BANK', label: 'BCA Savings', details: '1234567890' })
      .expect(201);
    expect(res.body.rail).toBe('BANK');
    expect(res.body.label).toBe('BCA Savings');
  });

  it('LP heartbeat → 200', async () => {
    const freshLpJwt = await mintJwt(app, lpKp);
    await request(app.getHttpServer())
      .post('/lp/heartbeat')
      .set('Authorization', `Bearer ${freshLpJwt}`)
      .expect(200);
  });

  it('LP set availability online=false → 200', async () => {
    const freshLpJwt = await mintJwt(app, lpKp);
    await request(app.getHttpServer())
      .post('/lp/availability')
      .set('Authorization', `Bearer ${freshLpJwt}`)
      .send({ available: false })
      .expect(200);
  });

  it('GET /admin/config → returns config', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/config')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    expect(typeof res.body.platformFeeBps).toBe('number');
    expect(typeof res.body.lpFeeBps).toBe('number');
  });

  it('non-admin PATCH /admin/config → 403', async () => {
    await request(app.getHttpServer())
      .patch('/admin/config')
      .set('Authorization', `Bearer ${userJwt}`)
      .send({ platformFeeBps: 50 })
      .expect(403);
  });

  it('invalid bps patch (platformFeeBps + lpFeeBps >= 10000) → 400', async () => {
    await request(app.getHttpServer())
      .patch('/admin/config')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ platformFeeBps: 30, lpFeeBps: 9970 })
      .expect(400);
  });

  it('valid bps patch → 200', async () => {
    const res = await request(app.getHttpServer())
      .patch('/admin/config')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ platformFeeBps: 30, lpFeeBps: 120 })
      .expect(200);
    expect(res.body.platformFeeBps).toBe(30);
    expect(res.body.lpFeeBps).toBe(120);
  });

  it('invalid rail on payment method → 400', async () => {
    const freshLpJwt = await mintJwt(app, lpKp);
    await request(app.getHttpServer())
      .post('/lp/payment-methods')
      .set('Authorization', `Bearer ${freshLpJwt}`)
      .send({ rail: 'INVALID', label: 'Bad Rail', details: '999' })
      .expect(400);
  });

  it('approved LP re-applies → status resets to PENDING, but the administrator note survives', async () => {
    const freshLpJwt = await mintJwt(app, lpKp);

    const res = await request(app.getHttpServer())
      .post('/lp/apply')
      .set('Authorization', `Bearer ${freshLpJwt}`)
      .send({ contact: 'updated@test.com', liquidityProof: 'new-proof' })
      .expect(201);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.approvedAt).toBeNull();

    const row = await prisma.lp.findUnique({ where: { id: lpId } });
    expect(row?.approvalNote).toBeTruthy();

    const listRes = await request(app.getHttpServer())
      .get('/admin/lps?status=APPROVED')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    const found = (listRes.body as any[]).find((l: any) => l.id === lpId);
    expect(found).toBeUndefined();
  });

  it('GET /admin/lps?status=BOGUS → 400', async () => {
    await request(app.getHttpServer())
      .get('/admin/lps?status=BOGUS')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(400);
  });

  it('PATCH /admin/config with bad platformWallet → 400', async () => {
    await request(app.getHttpServer())
      .patch('/admin/config')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ platformWallet: 'not-a-stellar-key' })
      .expect(400);
  });

  it('LP updates payment method details → 200', async () => {
    await request(app.getHttpServer())
      .post(`/admin/lps/${lpId}/approve`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ note: 'Re-approved for update test' });
    const freshLpJwt = await mintJwt(app, lpKp);

    const addRes = await request(app.getHttpServer())
      .post('/lp/payment-methods')
      .set('Authorization', `Bearer ${freshLpJwt}`)
      .send({ rail: 'QRIS', label: 'My QRIS', details: 'old-detail' })
      .expect(201);
    const pmId = addRes.body.id;

    const updateRes = await request(app.getHttpServer())
      .patch(`/lp/payment-methods/${pmId}`)
      .set('Authorization', `Bearer ${freshLpJwt}`)
      .send({ details: 'new-detail', label: 'Updated QRIS' })
      .expect(200);
    expect(updateRes.body.label).toBe('Updated QRIS');

    expect(updateRes.body.details).toBe('new-detail');
  });

  it('live role resolution: approved LP → lp access; after suspend → 403 immediately', async () => {
    await request(app.getHttpServer())
      .post(`/admin/lps/${lpId}/approve`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ note: 'for live-role test' })
      .expect(200);

    const lpTokenWhileApproved = await mintJwt(app, lpKp);

    await request(app.getHttpServer())
      .post('/lp/availability')
      .set('Authorization', `Bearer ${lpTokenWhileApproved}`)
      .send({ available: true })
      .expect(200);

    await request(app.getHttpServer())
      .post(`/admin/lps/${lpId}/suspend`)
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ note: 'suspended for live-role test' })
      .expect(200);

    await request(app.getHttpServer())
      .post('/lp/availability')
      .set('Authorization', `Bearer ${lpTokenWhileApproved}`)
      .send({ available: false })
      .expect(403);
  });

  it('GET /admin/orders → 200 for admin (may be empty list), 403 for non-admin', async () => {
    const res = await request(app.getHttpServer())
      .get('/admin/orders')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    expect(Array.isArray(res.body)).toBe(true);

    for (const order of res.body) {
      expect(order).not.toHaveProperty('payment_instructions');
    }

    await request(app.getHttpServer())
      .get('/admin/orders')
      .set('Authorization', `Bearer ${userJwt}`)
      .expect(403);
  });

  it('GET /admin/orders?status=INVALID → 400', async () => {
    await request(app.getHttpServer())
      .get('/admin/orders?status=INVALID')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(400);
  });

  it('PATCH /admin/config: manualRateOverride is retired — 400 on input, never echoed by GET', async () => {
    const res = await request(app.getHttpServer())
      .patch('/admin/config')
      .set('Authorization', `Bearer ${adminJwt}`)
      .send({ manualRateOverride: 'not-a-number', spreadBps: 150 })
      .expect(400);
    expect(res.body.message).toEqual(
      expect.arrayContaining([expect.stringContaining('manualRateOverride should not exist')]),
    );

    const getRes = await request(app.getHttpServer())
      .get('/admin/config')
      .set('Authorization', `Bearer ${adminJwt}`)
      .expect(200);
    expect(getRes.body.manualRateOverride).toBeUndefined();
  });
});
