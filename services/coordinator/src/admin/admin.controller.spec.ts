import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import request from 'supertest';

import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

const VALID_UUID_V4 = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const BAD_ID = 'not-a-uuid';

describe('AdminController LP status routes — UUID validation (L1)', () => {
  let app: INestApplication;

  const mockAdminService = {
    setStatus: jest.fn().mockResolvedValue({ id: VALID_UUID_V4, status: 'APPROVED' }),
    register: jest.fn().mockResolvedValue({ id: VALID_UUID_V4, status: 'APPROVED' }),
    list: jest.fn().mockResolvedValue([]),
    listOrders: jest.fn().mockResolvedValue([]),
    config: jest.fn().mockResolvedValue({ id: 1 }),
    updateConfigTransactional: jest.fn(),
    listMarkets: jest.fn().mockResolvedValue([]),
    updateMarket: jest.fn(),
    getOrderRisk: jest.fn(),
    getMetricsOverview: jest.fn(),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      controllers: [AdminController],
      providers: [{ provide: AdminService, useValue: mockAdminService }],
    })
      .overrideGuard(AuthGuard('jwt'))
      .useValue({
        canActivate: (ctx: ExecutionContext) => {
          ctx.switchToHttp().getRequest().user = { address: 'GADMIN', role: 'admin' };
          return true;
        },
      })
      .overrideGuard(require('../auth/roles.guard').RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();

    app = mod.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
    );
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('(L1) POST /admin/lps/:id/approve with non-UUID id → 400', async () => {
    await request(app.getHttpServer())
      .post(`/admin/lps/${BAD_ID}/approve`)
      .send({})
      .expect(400);
    expect(mockAdminService.setStatus).not.toHaveBeenCalled();
  });

  it('(L1) POST /admin/lps/:id/suspend with non-UUID id → 400', async () => {
    await request(app.getHttpServer())
      .post(`/admin/lps/${BAD_ID}/suspend`)
      .send({})
      .expect(400);
    expect(mockAdminService.setStatus).not.toHaveBeenCalled();
  });

  it('(L1) POST /admin/lps/:id/revoke with non-UUID id → 400', async () => {
    await request(app.getHttpServer())
      .post(`/admin/lps/${BAD_ID}/revoke`)
      .send({})
      .expect(400);
    expect(mockAdminService.setStatus).not.toHaveBeenCalled();
  });

  it('POST /admin/lps/:id/approve with valid UUID → 200 (service called)', async () => {
    await request(app.getHttpServer())
      .post(`/admin/lps/${VALID_UUID_V4}/approve`)
      .send({})
      .expect(200);
    expect(mockAdminService.setStatus).toHaveBeenCalledWith(VALID_UUID_V4, 'APPROVED', undefined, expect.anything());
  });

  const VALID_ADDR = 'G' + 'A'.repeat(55);

  it('POST /admin/lps with a valid body → 201 (service called)', async () => {
    await request(app.getHttpServer())
      .post('/admin/lps')
      .send({ stellarAddress: VALID_ADDR, contact: 'tg:@lp' })
      .expect(201);
    expect(mockAdminService.register).toHaveBeenCalled();
  });

  it('POST /admin/lps with an invalid stellarAddress → 400 (service not called)', async () => {
    await request(app.getHttpServer())
      .post('/admin/lps')
      .send({ stellarAddress: 'not-an-address', contact: 'tg:@lp' })
      .expect(400);
    expect(mockAdminService.register).not.toHaveBeenCalled();
  });

  it('POST /admin/lps without contact → 400 (service not called)', async () => {
    await request(app.getHttpServer())
      .post('/admin/lps')
      .send({ stellarAddress: VALID_ADDR })
      .expect(400);
    expect(mockAdminService.register).not.toHaveBeenCalled();
  });

  it('GET /admin/orders → fiat_currency present, matching the order.service serializer shape', async () => {
    const ORDER_ROW = {
      id: 'order-1',
      tradeId: 't'.repeat(64),
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'WITHDRAW',
      rail: 'BANK',
      usdcAmount: 100_000_000n,
      fiatAmount: 1_600_000n,
      fiatCurrency: 'PHP',
      rateSnapshot: '16000',
      platformFeeBps: 30,
      lpFeeBps: 120,
      status: 'MATCHED',
      payDeadline: BigInt(1000),
      confirmDeadline: BigInt(2000),
      disputeDeadline: BigInt(3000),
      expiresAt: new Date('2026-07-01T00:00:00.000Z'),
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    mockAdminService.listOrders.mockResolvedValue([ORDER_ROW]);

    const res = await request(app.getHttpServer())
      .get('/admin/orders')
      .set('Authorization', `Bearer admin`)
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].fiat_currency).toBe('PHP');
  });

  it('GET /admin/orders → Phase 5B fields null when unset on the row', async () => {
    const ORDER_ROW = {
      id: 'order-1',
      tradeId: 't'.repeat(64),
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'WITHDRAW',
      rail: 'QRIS',
      usdcAmount: 100_000_000n,
      fiatAmount: 1_600_000n,
      fiatCurrency: 'IDR',
      rateSnapshot: '16000',
      platformFeeBps: 30,
      lpFeeBps: 120,
      status: 'MATCHED',
      payDeadline: BigInt(1000),
      confirmDeadline: BigInt(2000),
      disputeDeadline: BigInt(3000),
      expiresAt: new Date('2026-07-01T00:00:00.000Z'),
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    mockAdminService.listOrders.mockResolvedValue([ORDER_ROW]);

    const res = await request(app.getHttpServer())
      .get('/admin/orders')
      .set('Authorization', `Bearer admin`)
      .expect(200);

    const order = res.body[0];
    expect(order.ref).toBeNull();
    expect(order.proof_url).toBeNull();
    expect(order.settled_at).toBeNull();
    expect(order.dispute_by).toBeNull();
    expect(order.dispute_reason).toBeNull();
    expect(order.dispute_note).toBeNull();
    expect(order.dispute_evidence_url).toBeNull();
    expect(order.dispute_at).toBeNull();
    expect(order.resolution).toBeNull();
  });

  it('GET /admin/orders → Phase 5B dispute/settlement fields surfaced when set on the row', async () => {
    const ORDER_ROW = {
      id: 'order-1',
      tradeId: 't'.repeat(64),
      userAddress: 'GUSER',
      lpWallet: 'GLP',
      flow: 'TOP_UP',
      rail: 'BANK',
      usdcAmount: 100_000_000n,
      fiatAmount: 1_600_000n,
      fiatCurrency: 'IDR',
      rateSnapshot: '16000',
      platformFeeBps: 30,
      lpFeeBps: 120,
      status: 'DISPUTED',
      payDeadline: BigInt(1000),
      confirmDeadline: BigInt(2000),
      disputeDeadline: BigInt(3000),
      expiresAt: new Date('2026-07-01T00:00:00.000Z'),
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      ref: 'LP-AB23',
      disputeBy: 'GUSER',
      disputeReason: 'USDC_NOT_RELEASED',
      disputeNote: 'never got the funds',
      disputeEvidenceUrl: '/uploads/evidence.png',
      disputeAt: new Date('2026-07-01T02:00:00.000Z'),
    };
    mockAdminService.listOrders.mockResolvedValue([ORDER_ROW]);

    const res = await request(app.getHttpServer())
      .get('/admin/orders')
      .set('Authorization', `Bearer admin`)
      .expect(200);

    const order = res.body[0];
    expect(order.ref).toBe('LP-AB23');
    expect(order.dispute_by).toBe('GUSER');
    expect(order.dispute_reason).toBe('USDC_NOT_RELEASED');
    expect(order.dispute_note).toBe('never got the funds');
    expect(order.dispute_evidence_url).toBe('/uploads/evidence.png');
    expect(order.dispute_at).toBe('2026-07-01T02:00:00.000Z');
  });

  it('GET /admin/orders → post_settle_dispute_until is an ISO deadline for a RELEASED order within the window, not yet disputed', async () => {
    const settledAt = new Date(Date.now() - 60_000);
    mockAdminService.config.mockResolvedValue({ postSettleDisputeWindowSecs: 3600 });
    mockAdminService.listOrders.mockResolvedValue([
      {
        id: 'order-1',
        tradeId: 't'.repeat(64),
        userAddress: 'GUSER',
        lpWallet: 'GLP',
        flow: 'TOP_UP',
        rail: 'BANK',
        usdcAmount: 100_000_000n,
        fiatAmount: 1_600_000n,
        fiatCurrency: 'IDR',
        rateSnapshot: '16000',
        platformFeeBps: 30,
        lpFeeBps: 120,
        status: 'RELEASED',
        payDeadline: BigInt(1000),
        confirmDeadline: BigInt(2000),
        disputeDeadline: BigInt(3000),
        expiresAt: new Date('2026-07-01T00:00:00.000Z'),
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        settledAt,
        disputeBy: null,
      },
    ]);

    const res = await request(app.getHttpServer())
      .get('/admin/orders')
      .set('Authorization', `Bearer admin`)
      .expect(200);

    expect(res.body[0].post_settle_dispute_until).toBe(
      new Date(settledAt.getTime() + 3600 * 1000).toISOString(),
    );
  });

  it('GET /admin/orders → post_settle_dispute_until is null once a dispute is on file', async () => {
    const settledAt = new Date(Date.now() - 60_000);
    mockAdminService.config.mockResolvedValue({ postSettleDisputeWindowSecs: 3600 });
    mockAdminService.listOrders.mockResolvedValue([
      {
        id: 'order-1',
        tradeId: 't'.repeat(64),
        userAddress: 'GUSER',
        lpWallet: 'GLP',
        flow: 'TOP_UP',
        rail: 'BANK',
        usdcAmount: 100_000_000n,
        fiatAmount: 1_600_000n,
        fiatCurrency: 'IDR',
        rateSnapshot: '16000',
        platformFeeBps: 30,
        lpFeeBps: 120,
        status: 'RELEASED',
        payDeadline: BigInt(1000),
        confirmDeadline: BigInt(2000),
        disputeDeadline: BigInt(3000),
        expiresAt: new Date('2026-07-01T00:00:00.000Z'),
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
        settledAt,
        disputeBy: 'user',
        disputeReason: 'PAYMENT_NOT_RECEIVED',
      },
    ]);

    const res = await request(app.getHttpServer())
      .get('/admin/orders')
      .set('Authorization', `Bearer admin`)
      .expect(200);

    expect(res.body[0].post_settle_dispute_until).toBeNull();
  });

  const MARKET_ROW = {
    code: 'IDR',
    country: 'Indonesia',
    currencySymbol: 'Rp',
    locale: 'id-ID',
    railName: 'QRIS',
    rateSource: 'coingecko',
    manualRateOverride: null,
    priceMinPerUsdc: '5000',
    priceMaxPerUsdc: '50000',
    decimals: 0,
    enabled: true,
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  };

  it('GET /admin/markets → 200, full rows serialized snake_case incl. internal fields', async () => {
    mockAdminService.listMarkets.mockResolvedValue([MARKET_ROW]);

    const res = await request(app.getHttpServer())
      .get('/admin/markets')
      .set('Authorization', `Bearer admin`)
      .expect(200);

    expect(res.body).toEqual([
      {
        code: 'IDR',
        country: 'Indonesia',
        currency_symbol: 'Rp',
        locale: 'id-ID',
        rail_name: 'QRIS',
        rate_source: 'coingecko',
        manual_rate_override: null,
        price_min_per_usdc: '5000',
        price_max_per_usdc: '50000',
        decimals: 0,
        enabled: true,
        updated_at: MARKET_ROW.updatedAt.toISOString(),
      },
    ]);
  });

  it('PATCH /admin/markets/:code with a valid body → delegates to AdminService.updateMarket', async () => {
    mockAdminService.updateMarket.mockResolvedValue({ ...MARKET_ROW, enabled: false });

    const res = await request(app.getHttpServer())
      .patch('/admin/markets/IDR')
      .send({ enabled: false })
      .expect(200);

    expect(mockAdminService.updateMarket).toHaveBeenCalledWith('IDR', { enabled: false }, expect.anything());
    expect(res.body.enabled).toBe(false);
    expect(res.body.code).toBe('IDR');
  });

  it('PATCH /admin/markets/:code with a lowercase code → 400 (service not called)', async () => {
    await request(app.getHttpServer())
      .patch('/admin/markets/idr')
      .send({ enabled: false })
      .expect(400);
    expect(mockAdminService.updateMarket).not.toHaveBeenCalled();
  });

  it('PATCH /admin/markets/:code with a non-3-letter code → 400 (service not called)', async () => {
    await request(app.getHttpServer())
      .patch('/admin/markets/IDRX')
      .send({ enabled: false })
      .expect(400);
    expect(mockAdminService.updateMarket).not.toHaveBeenCalled();
  });

  it('PATCH /admin/markets/:code with a malformed manualRateOverride → 400 (DTO validation, service not called)', async () => {
    await request(app.getHttpServer())
      .patch('/admin/markets/IDR')
      .send({ manualRateOverride: 'not-a-number' })
      .expect(400);
    expect(mockAdminService.updateMarket).not.toHaveBeenCalled();
  });

  it('PATCH /admin/markets/:code accepts manualRateOverride: null (clears the override)', async () => {
    mockAdminService.updateMarket.mockResolvedValue({ ...MARKET_ROW, manualRateOverride: null });

    await request(app.getHttpServer())
      .patch('/admin/markets/IDR')
      .send({ manualRateOverride: null })
      .expect(200);

    expect(mockAdminService.updateMarket).toHaveBeenCalledWith('IDR', { manualRateOverride: null }, expect.anything());
  });

  it('PATCH /admin/markets/:code with a malformed priceMinPerUsdc → 400 (service not called)', async () => {
    await request(app.getHttpServer())
      .patch('/admin/markets/IDR')
      .send({ priceMinPerUsdc: 'abc' })
      .expect(400);
    expect(mockAdminService.updateMarket).not.toHaveBeenCalled();
  });

  it('PATCH /admin/markets/:code with an empty railName → 400 (service not called)', async () => {
    await request(app.getHttpServer())
      .patch('/admin/markets/IDR')
      .send({ railName: '' })
      .expect(400);
    expect(mockAdminService.updateMarket).not.toHaveBeenCalled();
  });

  it('PATCH /admin/markets/:code with an unknown field → 400 (forbidNonWhitelisted, matches main.ts)', async () => {
    await request(app.getHttpServer())
      .patch('/admin/markets/IDR')
      .send({ enabled: true, notAField: 'x' })
      .expect(400);

    expect(mockAdminService.updateMarket).not.toHaveBeenCalled();
  });

  const CONFIG_ROW = {
    id: 1,
    spreadBps: 150,
    platformFeeBps: 30,
    lpFeeBps: 120,
    platformWallet: 'GPLATFORM',
    minOrder: 50_000_000n,
    maxOrder: 10_000_000_000n,
    payWindowSecs: 1800,
    confirmWindowSecs: 1800,
    disputeWindowSecs: 7200,
    paused: false,
    requireProof: true,
    autoRefund: true,
    dailyLimitByTier: null,
    postSettleDisputeWindowSecs: 3600,
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
  };

  it('GET /admin/config → 200, new F5 fields present, manualRateOverride dropped, BigInts as strings', async () => {
    mockAdminService.config.mockResolvedValue(CONFIG_ROW);

    const res = await request(app.getHttpServer())
      .get('/admin/config')
      .set('Authorization', `Bearer admin`)
      .expect(200);

    expect(res.body.manualRateOverride).toBeUndefined();
    expect(res.body.minOrder).toBe('50000000');
    expect(res.body.maxOrder).toBe('10000000000');
    expect(res.body.requireProof).toBe(true);
    expect(res.body.autoRefund).toBe(true);
    expect(res.body.postSettleDisputeWindowSecs).toBe(3600);
  });

  it.each([
    ['requireProof', { requireProof: false }],
    ['autoRefund', { autoRefund: false }],
    ['dailyLimitByTier', { dailyLimitByTier: { BRONZE: 500, GOLD: 50000 } }],
    ['postSettleDisputeWindowSecs', { postSettleDisputeWindowSecs: 1800 }],
    ['payWindowSecs at the usable floor, twice the on-chain minimum', { payWindowSecs: 1200 }],
    ['confirmWindowSecs', { confirmWindowSecs: 900 }],
    ['disputeWindowSecs', { disputeWindowSecs: 3600 }],
    ['minOrder', { minOrder: '10000000' }],
    ['maxOrder', { maxOrder: '20000000000' }],
  ])('PATCH /admin/config accepts %s → delegates to AdminService', async (_label, body) => {
    mockAdminService.updateConfigTransactional.mockResolvedValue({ ...CONFIG_ROW, ...body });

    await request(app.getHttpServer()).patch('/admin/config').send(body).expect(200);

    expect(mockAdminService.updateConfigTransactional).toHaveBeenCalledWith(body, expect.anything());
  });

  it.each([
    ['requireProof not a boolean', { requireProof: 'yes' }],
    ['autoRefund not a boolean', { autoRefund: 1 }],
    ['dailyLimitByTier empty object', { dailyLimitByTier: {} }],
    ['dailyLimitByTier unknown tier key', { dailyLimitByTier: { PLATINUM: 100 } }],
    ['dailyLimitByTier negative value', { dailyLimitByTier: { BRONZE: -5 } }],
    ['dailyLimitByTier non-integer value', { dailyLimitByTier: { BRONZE: 1.5 } }],
    ['postSettleDisputeWindowSecs zero', { postSettleDisputeWindowSecs: 0 }],
    ['postSettleDisputeWindowSecs over the 7-day cap', { postSettleDisputeWindowSecs: 604801 }],
    ['payWindowSecs below the usable floor', { payWindowSecs: 599 }],
    ['payWindowSecs at the contract floor, which leaves zero seconds to sign', { payWindowSecs: 600 }],
    ['confirmWindowSecs zero', { confirmWindowSecs: 0 }],
    ['disputeWindowSecs negative', { disputeWindowSecs: -1 }],
    ['minOrder not numeric', { minOrder: 'abc' }],
    ['minOrder zero (not positive)', { minOrder: '0' }],
    ['maxOrder with a decimal', { maxOrder: '10.5' }],
  ])('PATCH /admin/config rejects %s → 400 (service not called)', async (_label, body) => {
    await request(app.getHttpServer()).patch('/admin/config').send(body).expect(400);
    expect(mockAdminService.updateConfigTransactional).not.toHaveBeenCalled();
  });

  it('PATCH /admin/config surfaces AdminService ORDER_BOUNDS_INVALID as 400', async () => {
    mockAdminService.updateConfigTransactional.mockRejectedValue(
      new Error('ORDER_BOUNDS_INVALID'),
    );

    const res = await request(app.getHttpServer())
      .patch('/admin/config')
      .send({ minOrder: '999999999999' })
      .expect(400);

    expect(res.body.message).toMatch(/minOrder must be less than maxOrder/i);
  });

  it('PATCH /admin/config surfaces AdminService PLATFORM_FEE_DIVERGES_FROM_CHAIN as 400 with the reason', async () => {
    mockAdminService.updateConfigTransactional.mockRejectedValueOnce(
      new Error('PLATFORM_FEE_DIVERGES_FROM_CHAIN: platformFeeBps (40) must equal the escrow contract default_platform_fee_bps (30)'),
    );
    const res = await request(app.getHttpServer()).patch('/admin/config').send({ platformFeeBps: 40 }).expect(400);
    expect(res.body.message).toMatch(/default_platform_fee_bps \(30\)/);
  });

  it('PATCH /admin/config surfaces AdminService PLATFORM_FEE_EXCEEDS_SPREAD as 400 with the reason, never as a 500', async () => {
    mockAdminService.updateConfigTransactional.mockRejectedValueOnce(
      new Error('PLATFORM_FEE_EXCEEDS_SPREAD: platformFeeBps (60) plus priceDeviationMaxBps (100) must stay strictly below Config.spreadBps (150)'),
    );
    const res = await request(app.getHttpServer()).patch('/admin/config').send({ platformFeeBps: 60 }).expect(400);
    expect(res.body.message).toMatch(/platformFeeBps \(60\)/);
    expect(res.body.message).not.toMatch(/^PLATFORM_FEE_EXCEEDS_SPREAD/);
  });

  it('PATCH /admin/config surfaces AdminService SPREAD_TOO_NARROW as 400 without the error prefix', async () => {
    mockAdminService.updateConfigTransactional.mockRejectedValue(
      new Error('SPREAD_TOO_NARROW: PRICE_DEVIATION_MAX_BPS (100) must stay strictly below Config.spreadBps (100) — INV-30.1'),
    );

    const res = await request(app.getHttpServer())
      .patch('/admin/config')
      .send({ spreadBps: 100 })
      .expect(400);

    expect(res.body.message).toMatch(/INV-30\.1/);
    expect(res.body.message).not.toMatch(/SPREAD_TOO_NARROW/);
  });

  it('PATCH /admin/config still rejects an unknown field (forbidNonWhitelisted)', async () => {
    await request(app.getHttpServer())
      .patch('/admin/config')
      .send({ notAField: 'x' })
      .expect(400);
    expect(mockAdminService.updateConfigTransactional).not.toHaveBeenCalled();
  });

  it('GET /admin/orders/:id/risk with a non-UUID id → 400 (service not called)', async () => {
    await request(app.getHttpServer())
      .get(`/admin/orders/${BAD_ID}/risk`)
      .expect(400);
    expect(mockAdminService.getOrderRisk).not.toHaveBeenCalled();
  });

  it('GET /admin/orders/:id/risk → 200, snake_case serialized, nested lp_completion untouched', async () => {
    mockAdminService.getOrderRisk.mockResolvedValue({
      walletAgeDays: 42,
      userDisputeVelocity30d: 1,
      lpDisputeVelocity30d: 0,
      amountVsTierLimit: {
        orderUsdc: 50,
        tier: 'SILVER',
        dailyLimitUsdc: 300,
        ratio: 50 / 300,
      },
      lpCompletion: {
        completed_trades: 8,
        completion_rate: 0.8,
        member_since: '2026-01-01T00:00:00.000Z',
        online: true,
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/admin/orders/${VALID_UUID_V4}/risk`)
      .expect(200);

    expect(mockAdminService.getOrderRisk).toHaveBeenCalledWith(VALID_UUID_V4);
    expect(res.body).toEqual({
      wallet_age_days: 42,
      user_dispute_velocity_30d: 1,
      lp_dispute_velocity_30d: 0,
      amount_vs_tier_limit: {
        order_usdc: 50,
        tier: 'SILVER',
        daily_limit_usdc: 300,
        ratio: 50 / 300,
      },
      lp_completion: {
        completed_trades: 8,
        completion_rate: 0.8,
        member_since: '2026-01-01T00:00:00.000Z',
        online: true,
      },
    });
  });

  it('GET /admin/orders/:id/risk → wallet_age_days and lp_completion null when unknown/no lpId', async () => {
    mockAdminService.getOrderRisk.mockResolvedValue({
      walletAgeDays: null,
      userDisputeVelocity30d: 0,
      lpDisputeVelocity30d: 0,
      amountVsTierLimit: { orderUsdc: 10, tier: 'BRONZE', dailyLimitUsdc: 100, ratio: 0.1 },
      lpCompletion: null,
    });

    const res = await request(app.getHttpServer())
      .get(`/admin/orders/${VALID_UUID_V4}/risk`)
      .expect(200);

    expect(res.body.wallet_age_days).toBeNull();
    expect(res.body.lp_completion).toBeNull();
  });

  const METRICS_OVERVIEW: any = {
    range: '24h',
    volumeUsdc: 150,
    feesUsdc: 2.25,
    avgSettleSecs: 842.5,
    openDisputes: 3,
    ordersCount: 2,
    dailyBars: [{ date: '2026-07-08', volumeUsdc: 150 }],
    flowMix: [{ flow: 'TOP_UP', count: 2, volumeUsdc: 150 }],
    topLps: [{ lpId: 'lp-1', address: 'GLP1', volumeUsdc: 150, trades: 2 }],
  };

  it('GET /admin/metrics/overview with no range → defaults to 24h and delegates to AdminService', async () => {
    mockAdminService.getMetricsOverview.mockResolvedValue(METRICS_OVERVIEW);

    const res = await request(app.getHttpServer()).get('/admin/metrics/overview').expect(200);

    expect(mockAdminService.getMetricsOverview).toHaveBeenCalledWith('24h');
    expect(res.body).toEqual({
      range: '24h',
      volume_usdc: 150,
      fees_usdc: 2.25,
      avg_settle_secs: 842.5,
      open_disputes: 3,
      orders_count: 2,
      daily_bars: [{ date: '2026-07-08', volume_usdc: 150 }],
      flow_mix: [{ flow: 'TOP_UP', count: 2, volume_usdc: 150 }],
      top_lps: [{ lp_id: 'lp-1', address: 'GLP1', volume_usdc: 150, trades: 2 }],
    });
  });

  it.each(['24h', '7d', '30d'])(
    'GET /admin/metrics/overview?range=%s → delegates the explicit range',
    async (range) => {
      mockAdminService.getMetricsOverview.mockResolvedValue({ ...METRICS_OVERVIEW, range });

      const res = await request(app.getHttpServer())
        .get(`/admin/metrics/overview?range=${range}`)
        .expect(200);

      expect(mockAdminService.getMetricsOverview).toHaveBeenCalledWith(range);
      expect(res.body.range).toBe(range);
    },
  );

  it('GET /admin/metrics/overview?range=1y (unsupported) → 400, service not called', async () => {
    await request(app.getHttpServer()).get('/admin/metrics/overview?range=1y').expect(400);
    expect(mockAdminService.getMetricsOverview).not.toHaveBeenCalled();
  });

  it('GET /admin/metrics/overview → avg_settle_secs null and empty arrays pass through untouched', async () => {
    mockAdminService.getMetricsOverview.mockResolvedValue({
      range: '24h',
      volumeUsdc: 0,
      feesUsdc: 0,
      avgSettleSecs: null,
      openDisputes: 0,
      ordersCount: 0,
      dailyBars: [],
      flowMix: [],
      topLps: [],
    });

    const res = await request(app.getHttpServer()).get('/admin/metrics/overview').expect(200);

    expect(res.body.avg_settle_secs).toBeNull();
    expect(res.body.daily_bars).toEqual([]);
    expect(res.body.flow_mix).toEqual([]);
    expect(res.body.top_lps).toEqual([]);
    expect(res.body.volume_usdc).toBe(0);
    expect(res.body.fees_usdc).toBe(0);
    expect(res.body.orders_count).toBe(0);
    expect(res.body.open_disputes).toBe(0);
  });
});
