import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { withTxSupport, orderStatusFor, orderTxFor } from './test-helpers';

describe('OrderService.createFromQuote — per-tier daily limit re-check (Phase 6 Task 3)', () => {
  const USER = 'GUSER';
  const LP = 'GLP';
  const PLATFORM = 'GPLATFORM';

  function makeQuote(overrides: Record<string, any> = {}) {
    return {
      id: 'q1',
      userAddress: USER,
      flow: 'TOP_UP',
      rail: 'BANK',
      usdcAmount: 100_000_000n,
      fiatAmount: 1_600_000n,
      fiatCurrency: 'IDR',
      rateSnapshot: '16000',
      platformFeeBps: 30,
      lpFeeBps: 120,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      ...overrides,
    };
  }

  function makeUserReputation(overrides: Record<string, any> = {}) {
    return {
      getReputation: jest.fn().mockResolvedValue({
        tier: 'BRONZE',
        completedTrades: 0,
        disputesLost: 0,
        completionRate: null,
      }),
      dailyLimitBaseUnits: jest.fn().mockReturnValue(1_000_000_000n),
      used24hBaseUnits: jest.fn().mockResolvedValue(0n),
      ...overrides,
    } as any;
  }

  function makeSvc(quoteOverrides: Record<string, any> = {}, userReputation = makeUserReputation()) {
    const quote = makeQuote(quoteOverrides);
    const prisma = {
      quote: {
        findUnique: jest.fn().mockResolvedValue(quote),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        create: jest.fn().mockResolvedValue({
          id: 'ord-1',
          tradeId: 't1',
          userAddress: USER,
          lpId: 'lp1',
          flow: quote.flow,
          rail: quote.rail,
          fiatCurrency: quote.fiatCurrency,
          usdcAmount: quote.usdcAmount,
          fiatAmount: quote.fiatAmount,
          rateSnapshot: quote.rateSnapshot,
          platformFeeBps: quote.platformFeeBps,
          lpFeeBps: quote.lpFeeBps,
          platformWallet: PLATFORM,
          lpWallet: LP,
          status: 'MATCHED',
          payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
          confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
          disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
          expiresAt: new Date(Date.now() + 1_800_000),
          createdAt: new Date(),
          userPaymentDetails: null,
        }),
      },
      config: {
        upsert: jest.fn().mockResolvedValue({
          id: 1,
          paused: false,
          minOrder: 1n,
          maxOrder: 10_000_000_000n,
          platformWallet: PLATFORM,
          payWindowSecs: 1800,
          confirmWindowSecs: 1800,
          disputeWindowSecs: 1800,
        }),
      },
    } as any;
    withTxSupport(prisma);
    const stellar = { hasUsdcTrustline: jest.fn().mockResolvedValue(true) } as any;
    const matching = {
      pickLp: jest.fn().mockResolvedValue({ id: 'lp1', stellarAddress: LP, paymentMethodId: 'pm1', details: 'BCA 123' }),
    } as any;
    const cfg = { platformWallet: PLATFORM } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const storage = {} as any;
    const svc = new OrderService(prisma, stellar, matching, cfg, markets, notifications, storage, userReputation, orderStatusFor(prisma, stellar, cfg), orderTxFor(prisma, stellar, cfg));
    return { svc, prisma, userReputation };
  }

  it('allows creating an order when used24h + quote.usdcAmount is UNDER the tier limit', async () => {
    const userReputation = makeUserReputation({
      dailyLimitBaseUnits: jest.fn().mockReturnValue(1_000_000_000n),
      used24hBaseUnits: jest.fn().mockResolvedValue(500_000_000n),
    });
    const { svc, prisma } = makeSvc({ usdcAmount: 100_000_000n }, userReputation);
    const result = await svc.createFromQuote(USER, 'q1');
    expect(result).toBeTruthy();
    expect(prisma.order.create).toHaveBeenCalled();
  });

  it('allows creating an order when used24h + quote.usdcAmount EXACTLY EQUALS the limit (inclusive boundary)', async () => {
    const userReputation = makeUserReputation({
      dailyLimitBaseUnits: jest.fn().mockReturnValue(1_000_000_000n),
      used24hBaseUnits: jest.fn().mockResolvedValue(0n),
    });
    const { svc, prisma } = makeSvc({ usdcAmount: 1_000_000_000n }, userReputation);
    const result = await svc.createFromQuote(USER, 'q1');
    expect(result).toBeTruthy();
    expect(prisma.order.create).toHaveBeenCalled();
  });

  it('rejects creating an order that pushes used24h + quote.usdcAmount OVER the limit — 400 daily limit exceeded', async () => {
    const userReputation = makeUserReputation({
      dailyLimitBaseUnits: jest.fn().mockReturnValue(1_000_000_000n),
      used24hBaseUnits: jest.fn().mockResolvedValue(500_000_000n),
    });
    const { svc, prisma } = makeSvc({ usdcAmount: 600_000_000n }, userReputation);

    await expect(svc.createFromQuote(USER, 'q1')).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.quote.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('rejects with the exact message "daily limit exceeded"', async () => {
    const userReputation = makeUserReputation({
      dailyLimitBaseUnits: jest.fn().mockReturnValue(1_000_000_000n),
      used24hBaseUnits: jest.fn().mockResolvedValue(1_000_000_000n),
    });
    const { svc } = makeSvc({ usdcAmount: 1n }, userReputation);
    await expect(svc.createFromQuote(USER, 'q1')).rejects.toThrow('daily limit exceeded');
  });

  it('anti parallel-quote-bypass: two quotes each individually under-limit, but the SECOND create pushes cumulative usage over the limit — rejected', async () => {
    const limitBase = 1_000_000_000n;
    const secondQuoteAmount = 600_000_000n;

    const firstReputation = makeUserReputation({
      dailyLimitBaseUnits: jest.fn().mockReturnValue(limitBase),
      used24hBaseUnits: jest.fn().mockResolvedValue(0n),
    });
    const first = makeSvc({ id: 'q1', usdcAmount: 600_000_000n }, firstReputation);
    const firstResult = await first.svc.createFromQuote(USER, 'q1');
    expect(firstResult).toBeTruthy();

    const secondReputation = makeUserReputation({
      dailyLimitBaseUnits: jest.fn().mockReturnValue(limitBase),
      used24hBaseUnits: jest.fn().mockResolvedValue(600_000_000n),
    });
    const second = makeSvc({ id: 'q2', usdcAmount: secondQuoteAmount }, secondReputation);
    await expect(second.svc.createFromQuote(USER, 'q2')).rejects.toBeInstanceOf(BadRequestException);
    await expect(second.svc.createFromQuote(USER, 'q2')).rejects.toThrow('daily limit exceeded');
    expect(second.prisma.order.create).not.toHaveBeenCalled();
  });

  it('different tiers get different limits at create-time too', async () => {
    const userReputation = makeUserReputation({
      getReputation: jest.fn().mockResolvedValue({ tier: 'GOLD', completedTrades: 100, disputesLost: 0, completionRate: 1 }),
      dailyLimitBaseUnits: jest.fn((tier: string) => (tier === 'GOLD' ? 20_000_000_000n : 1_000_000_000n)),
      used24hBaseUnits: jest.fn().mockResolvedValue(0n),
    });
    const { svc, prisma } = makeSvc({ usdcAmount: 5_000_000_000n }, userReputation);
    const result = await svc.createFromQuote(USER, 'q1');
    expect(result).toBeTruthy();
    expect(prisma.order.create).toHaveBeenCalled();
    expect(userReputation.dailyLimitBaseUnits).toHaveBeenCalledWith('GOLD', expect.anything());
  });

  it('wires the resolved Config row into dailyLimitBaseUnits (Config.dailyLimitByTier override honored, wiring-level)', async () => {
    const userReputation = makeUserReputation();
    const { svc, prisma } = makeSvc({ usdcAmount: 1_000_000_000n }, userReputation);

    prisma.config.upsert.mockResolvedValue({
      id: 1,
      paused: false,
      minOrder: 1n,
      maxOrder: 10_000_000_000n,
      platformWallet: PLATFORM,
      payWindowSecs: 1800,
      confirmWindowSecs: 1800,
      disputeWindowSecs: 1800,
      dailyLimitByTier: { BRONZE: 5000 },
    });
    await svc.createFromQuote(USER, 'q1');
    expect(userReputation.dailyLimitBaseUnits).toHaveBeenCalledWith(
      'BRONZE',
      expect.objectContaining({ dailyLimitByTier: { BRONZE: 5000 } }),
    );
  });

  it('null/absent Config.dailyLimitByTier is passed through unchanged — defaults are UserReputationService\'s responsibility', async () => {
    const userReputation = makeUserReputation();
    const { svc } = makeSvc({ usdcAmount: 1_000_000_000n }, userReputation);
    await svc.createFromQuote(USER, 'q1');
    expect(userReputation.dailyLimitBaseUnits).toHaveBeenCalledWith(
      'BRONZE',
      expect.not.objectContaining({ dailyLimitByTier: expect.anything() }),
    );
  });

  it('fails CLOSED when getReputation throws at create-time — propagates, never silently allows the order', async () => {
    const userReputation = makeUserReputation({
      getReputation: jest.fn().mockRejectedValue(new Error('db unavailable')),
    });
    const { svc, prisma } = makeSvc({}, userReputation);
    await expect(svc.createFromQuote(USER, 'q1')).rejects.toThrow('db unavailable');
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('fails CLOSED when used24hBaseUnits throws at create-time — propagates, never silently allows the order', async () => {
    const userReputation = makeUserReputation({
      used24hBaseUnits: jest.fn().mockRejectedValue(new Error('db unavailable')),
    });
    const { svc, prisma } = makeSvc({}, userReputation);
    await expect(svc.createFromQuote(USER, 'q1')).rejects.toThrow('db unavailable');
    expect(prisma.order.create).not.toHaveBeenCalled();
  });
});
