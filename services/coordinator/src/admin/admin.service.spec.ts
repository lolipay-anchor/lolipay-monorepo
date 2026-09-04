import { BadGatewayException, BadRequestException, ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { AdminService } from './admin.service';
import { ConfigCache } from '../config/config-cache';

const ADDR = 'GBSYTTNQVWKH2DOIWXSE6UVJXRCUIXKSC5TBPYWNLCXLS35FKH7DNOHT';

function makePrisma() {
  const client: any = {
    lp: {
      findUnique: jest.fn(),
      create: jest.fn(async ({ data }: any) => ({ id: 'new', ...data })),
      update: jest.fn(async ({ data }: any) => ({ id: 'existing', ...data })),
    },
    config: {
      findUnique: jest.fn(async () => ({ id: 1, platformFeeBps: 30, lpFeeBps: 120, minOrder: 1n, maxOrder: 9n })),
      update: jest.fn(async ({ data }: any) => ({ id: 1, ...data })),
    },
    adminAudit: { create: jest.fn(async () => ({})) },
  };
  client.$transaction = jest.fn(async (cb: any) => cb(client));
  return client as any;
}

function chainFee(bps: number, stellar: any) {
  stellar.readEscrowPlatformFeeBps = jest.fn(async () => bps);
  return stellar;
}

function makeStellar(hasTrustline = true, cooldownSecs: number | Error = 349_201) {
  return {
    readEscrowPlatformFeeBps: jest.fn(async () => 30),
    hasUsdcTrustline: jest.fn().mockResolvedValue(hasTrustline),
    stakingCooldownSecs: jest.fn(() =>
      cooldownSecs instanceof Error ? Promise.reject(cooldownSecs) : Promise.resolve(cooldownSecs),
    ),
  } as any;
}

function makeCfg(over: Record<string, unknown> = {}) {
  return {
    usdcAssetCode: 'TUSDC',
    usdcAssetIssuer: 'GCMUR7GX',
    priceDeviationMaxBps: 100,
    escrowContractId: 'CDEFAULT',
    ...over,
  } as any;
}

function makeUserReputation(overrides: Record<string, any> = {}) {
  return {
    personIdFor: jest.fn().mockResolvedValue('person-test'),
    getReputation: jest.fn().mockResolvedValue({
      tier: 'BRONZE',
      completedTrades: 0,
      disputesLost: 0,
      completionRate: null,
    }),
    dailyLimitBaseUnits: jest.fn().mockReturnValue(100_0000000n),
    used24hBaseUnits: jest.fn().mockResolvedValue(0n),
    ...overrides,
  } as any;
}

function makeMarkets(overrides: Record<string, any> = {}) {
  return {
    list: jest.fn(),
    get: jest.fn(),
    update: jest.fn(),
    ...overrides,
  } as any;
}

describe('AdminService.register', () => {
  it('creates an APPROVED LP by default (admin vouches)', async () => {
    const prisma = makePrisma();
    prisma.lp.findUnique.mockResolvedValue(null);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    const lp = await svc.register({ stellarAddress: ADDR, contact: 'tg:@lp' } as any, 'GADMINTEST');

    expect(lp.status).toBe('APPROVED');
    expect(lp.approvedAt).toBeInstanceOf(Date);
    expect(lp.stellarAddress).toBe(ADDR);

    expect(lp.liquidityProof).toBe('Registered by admin');
    expect(lp.approvalNote).toBe('Registered by admin');
  });

  it('creates a PENDING LP with no approvedAt when approve=false', async () => {
    const prisma = makePrisma();
    prisma.lp.findUnique.mockResolvedValue(null);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    const lp = await svc.register({
      stellarAddress: ADDR,
      contact: 'tg:@lp',
      liquidityProof: 'on-chain balance',
      approve: false,
    } as any, 'GADMINTEST');

    expect(lp.status).toBe('PENDING');
    expect(lp.approvedAt).toBeNull();
    expect(lp.liquidityProof).toBe('on-chain balance');
  });

  it('rejects a duplicate wallet address with 409', async () => {
    const prisma = makePrisma();
    prisma.lp.findUnique.mockResolvedValue({ id: 'existing', stellarAddress: ADDR });
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await expect(
      svc.register({ stellarAddress: ADDR, contact: 'tg:@lp' } as any, 'GADMINTEST'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.lp.create).not.toHaveBeenCalled();
  });

  it('rejects an address with an invalid checksum (regex passes but StrKey fails)', async () => {
    const prisma = makePrisma();
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await expect(
      svc.register({ stellarAddress: 'G' + 'A'.repeat(55), contact: 'tg:@lp' } as any, 'GADMINTEST'),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.lp.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a wallet with no USDC trustline (would trap payouts)', async () => {
    const prisma = makePrisma();
    prisma.lp.findUnique.mockResolvedValue(null);
    const svc = new AdminService(prisma, makeStellar(false), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await expect(
      svc.register({ stellarAddress: ADDR, contact: 'tg:@lp' } as any, 'GADMINTEST'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.lp.create).not.toHaveBeenCalled();
  });
});

describe('a window change cannot outgrow the collateral it depends on', () => {
  it('refuses windows the deployed cooldown can no longer cover', async () => {
    const prisma = makePrisma();
    prisma.config.findUnique = jest.fn(async () => ({
      id: 1,
      spreadBps: 150,
      platformFeeBps: 30,
      lpFeeBps: 120,
      minOrder: 1n,
      maxOrder: 9n,
      payWindowSecs: 1800,
      confirmWindowSecs: 1800,
      disputeWindowSecs: 7200,
    }));
    const svc = new AdminService(prisma, chainFee(40, makeStellar(true, 349_201)), makeCfg(), {} as any, {} as any, {} as any, { notifyOrderStatus: jest.fn() } as any);

    await expect(
      svc.updateConfigTransactional({ payWindowSecs: 86_400 } as any, ADDR),
    ).rejects.toThrow(/cooldown/i);
  });

  it('refuses the change when the deployed cooldown cannot be read at all', async () => {
    const prisma = makePrisma();
    prisma.config.findUnique = jest.fn(async () => ({
      id: 1,
      spreadBps: 150,
      platformFeeBps: 30,
      lpFeeBps: 120,
      minOrder: 1n,
      maxOrder: 9n,
      payWindowSecs: 1800,
      confirmWindowSecs: 1800,
      disputeWindowSecs: 7200,
    }));
    const svc = new AdminService(
      prisma,
      makeStellar(true, new Error('rpc down')),
      makeCfg(),
      {} as any,
      {} as any,
      {} as any,
      { notifyOrderStatus: jest.fn() } as any,
    );

    await expect(
      svc.updateConfigTransactional({ payWindowSecs: 3600 } as any, ADDR),
    ).rejects.toThrow(/cooldown/i);
  });
});

describe('a change that cannot move the floor is not held hostage to the chain', () => {
  it('lets a fee change through even when the staking contract cannot be read', async () => {
    const prisma = makePrisma();
    prisma.config.findUnique = jest.fn(async () => ({
      id: 1,
      spreadBps: 150,
      platformFeeBps: 30,
      lpFeeBps: 120,
      minOrder: 1n,
      maxOrder: 9n,
      payWindowSecs: 1800,
      confirmWindowSecs: 1800,
      disputeWindowSecs: 7200,
    }));
    const svc = new AdminService(
      prisma,
      chainFee(40, makeStellar(true, new Error('rpc down'))),
      makeCfg(),
      {} as any,
      {} as any,
      {} as any,
      { notifyOrderStatus: jest.fn() } as any,
    );

    await expect(
      svc.updateConfigTransactional({ platformFeeBps: 40 } as any, ADDR),
    ).resolves.toBeDefined();
  });
});

describe('AdminService.updateConfigTransactional', () => {
  const CURRENT = {
    spreadBps: 150,
    platformFeeBps: 30,
    lpFeeBps: 120,
    minOrder: 50_000_000n,
    maxOrder: 10_000_000_000n,
    payWindowSecs: 1800,
    confirmWindowSecs: 1800,
    disputeWindowSecs: 7200,
  };

  function makeConfigPrisma(current: any) {
    const configApi = {
      findUnique: jest.fn().mockResolvedValue(current),
      update: jest.fn(async ({ data }: any) => ({ ...current, ...data })),
    };
    const auditApi = { create: jest.fn(async () => ({})) };
    const prisma = {
      config: configApi,
      adminAudit: auditApi,
      $transaction: jest.fn((cb: any) => cb({ config: configApi, adminAudit: auditApi })),
    } as any;
    return { prisma, configApi, auditApi };
  }

  function makeCachePrisma() {
    return { config: { upsert: jest.fn(async () => ({ id: 1, paused: false })) } } as any;
  }

  it('invalidates the cached platform config once the patch has committed', async () => {
    const { prisma } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);
    const cachePrisma = makeCachePrisma();
    const cache = new ConfigCache();

    await cache.read(cachePrisma, 'GADMINTEST');
    await svc.updateConfigTransactional({ paused: true } as any, 'GADMINTEST');
    await cache.read(cachePrisma, 'GADMINTEST');

    expect(cachePrisma.config.upsert).toHaveBeenCalledTimes(2);
  });

  it('leaves the cached platform config alone when the patch is rejected', async () => {
    const { prisma } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);
    const cachePrisma = makeCachePrisma();
    const cache = new ConfigCache();

    await cache.read(cachePrisma, 'GADMINTEST');
    await expect(
      svc.updateConfigTransactional({ platformFeeBps: 9970 } as any, 'GADMINTEST'),
    ).rejects.toThrow('BPS_OVERFLOW');
    await cache.read(cachePrisma, 'GADMINTEST');

    expect(cachePrisma.config.upsert).toHaveBeenCalledTimes(1);
  });

  it('rejects a platformFeeBps patch above the spread, because on a withdrawal the platform fee comes out of the spread and the record declares no fee', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);
    await expect(
      svc.updateConfigTransactional({ platformFeeBps: CURRENT.spreadBps + 1 } as any, 'GADMINTEST'),
    ).rejects.toThrow('PLATFORM_FEE_EXCEEDS_SPREAD');
    expect(configApi.update).not.toHaveBeenCalled();
  });

  it('rejects a spreadBps patch that drops below the stored platformFeeBps, using the CURRENT row for the omitted side', async () => {
    const { prisma, configApi } = makeConfigPrisma({ ...CURRENT, platformFeeBps: 140 });
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);
    await expect(
      svc.updateConfigTransactional({ spreadBps: 130 } as any, 'GADMINTEST'),
    ).rejects.toThrow('PLATFORM_FEE_EXCEEDS_SPREAD');
    expect(configApi.update).not.toHaveBeenCalled();
  });

  it('accepts a platformFeeBps patch that leaves a basis point after the deviation band, and refuses one that does not', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const room = CURRENT.spreadBps - makeCfg().priceDeviationMaxBps - 1;
    const svc = new AdminService(prisma, chainFee(room, makeStellar()), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);
    await svc.updateConfigTransactional({ platformFeeBps: room } as any, 'GADMINTEST');
    expect(configApi.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { platformFeeBps: room } });
    await expect(
      svc.updateConfigTransactional({ platformFeeBps: room + 1 } as any, 'GADMINTEST'),
    ).rejects.toThrow('PLATFORM_FEE_EXCEEDS_SPREAD');
    expect(configApi.update).toHaveBeenCalledTimes(1);
  });

  it('refuses a spreadBps patch that the old at-most rule would have taken but that leaves nothing after the deviation band', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);
    await expect(
      svc.updateConfigTransactional({ spreadBps: CURRENT.platformFeeBps + makeCfg().priceDeviationMaxBps } as any, 'GADMINTEST'),
    ).rejects.toThrow('PLATFORM_FEE_EXCEEDS_SPREAD');
    expect(configApi.update).not.toHaveBeenCalled();
  });

  it('refuses a platformFeeBps patch that diverges from the escrow contract default, because create_trade requires equality and every funding would revert', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const stellar = makeStellar();
    stellar.readEscrowPlatformFeeBps = jest.fn(async () => CURRENT.platformFeeBps);
    const svc = new AdminService(prisma, stellar, makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);
    await expect(
      svc.updateConfigTransactional({ platformFeeBps: CURRENT.platformFeeBps + 10 } as any, 'GADMINTEST'),
    ).rejects.toThrow('PLATFORM_FEE_DIVERGES_FROM_CHAIN');
    expect(configApi.update).not.toHaveBeenCalled();
  });

  it('accepts a platformFeeBps patch equal to the escrow contract default', async () => {
    const { prisma, configApi } = makeConfigPrisma({ ...CURRENT, platformFeeBps: 20 });
    const stellar = makeStellar();
    stellar.readEscrowPlatformFeeBps = jest.fn(async () => 30);
    const svc = new AdminService(prisma, stellar, makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);
    await svc.updateConfigTransactional({ platformFeeBps: 30 } as any, 'GADMINTEST');
    expect(configApi.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { platformFeeBps: 30 } });
  });

  it('refuses a platformFeeBps patch when the escrow contract default cannot be read, the way the windows are refused without the cooldown', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const stellar = makeStellar();
    stellar.readEscrowPlatformFeeBps = jest.fn(async () => { throw new Error('rpc down'); });
    const svc = new AdminService(prisma, stellar, makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);
    await expect(
      svc.updateConfigTransactional({ platformFeeBps: CURRENT.platformFeeBps } as any, 'GADMINTEST'),
    ).rejects.toThrow('PLATFORM_FEE_DIVERGES_FROM_CHAIN');
    expect(configApi.update).not.toHaveBeenCalled();
  });

  it('rejects a spreadBps patch that no longer covers the price-deviation allowance', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await expect(
      svc.updateConfigTransactional({ spreadBps: 100 } as any, 'GADMINTEST'),
    ).rejects.toThrow('SPREAD_TOO_NARROW');
    expect(configApi.update).not.toHaveBeenCalled();
  });

  it('accepts a spreadBps patch that keeps a cushion above the deviation allowance and the stored platform fee', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await svc.updateConfigTransactional({ spreadBps: 131 } as any, 'GADMINTEST');
    expect(configApi.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { spreadBps: 131 } });
  });

  it('does not block an unrelated config change when the stored spread already violates INV-30.1', async () => {
    const { prisma, configApi } = makeConfigPrisma({ ...CURRENT, spreadBps: 50 });
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await svc.updateConfigTransactional({ paused: true } as any, 'GADMINTEST');
    expect(configApi.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { paused: true } });
  });

  it('rejects when platformFeeBps + lpFeeBps >= 10000, using the CURRENT row for the omitted side', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await expect(
      svc.updateConfigTransactional({ platformFeeBps: 9970 } as any, 'GADMINTEST'),
    ).rejects.toThrow('BPS_OVERFLOW');
    expect(configApi.update).not.toHaveBeenCalled();
  });

  it('accepts a bps patch that stays under the 10000 sum', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, chainFee(40, makeStellar()), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await svc.updateConfigTransactional({ platformFeeBps: 40 } as any, 'GADMINTEST');
    expect(configApi.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { platformFeeBps: 40 },
    });
  });

  it('rejects minOrder >= maxOrder when only minOrder is patched (compares against CURRENT maxOrder)', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await expect(
      svc.updateConfigTransactional({ minOrder: '20000000000' } as any, 'GADMINTEST'),
    ).rejects.toThrow('ORDER_BOUNDS_INVALID');
    expect(configApi.update).not.toHaveBeenCalled();
  });

  it('rejects minOrder >= maxOrder when only maxOrder is patched (compares against CURRENT minOrder)', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await expect(
      svc.updateConfigTransactional({ maxOrder: '1000000' } as any, 'GADMINTEST'),
    ).rejects.toThrow('ORDER_BOUNDS_INVALID');
    expect(configApi.update).not.toHaveBeenCalled();
  });

  it('rejects minOrder === maxOrder (strict less-than, not less-or-equal)', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await expect(
      svc.updateConfigTransactional({ minOrder: '10000000000', maxOrder: '10000000000' } as any, 'GADMINTEST'),
    ).rejects.toThrow('ORDER_BOUNDS_INVALID');
    expect(configApi.update).not.toHaveBeenCalled();
  });

  it('accepts minOrder < maxOrder and writes both as BigInt', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await svc.updateConfigTransactional({
      minOrder: '10000000',
      maxOrder: '20000000000',
    } as any, 'GADMINTEST');

    expect(configApi.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { minOrder: 10_000_000n, maxOrder: 20_000_000_000n },
    });
  });

  it('leaves non-order fields untouched in the write payload (no stray minOrder/maxOrder when unpatched)', async () => {
    const { prisma, configApi } = makeConfigPrisma(CURRENT);
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await svc.updateConfigTransactional({ paused: true } as any, 'GADMINTEST');

    expect(configApi.update).toHaveBeenCalledWith({ where: { id: 1 }, data: { paused: true } });
  });
});

describe('AdminService.listMarkets', () => {
  it('delegates straight to MarketsService.list()', async () => {
    const rows = [{ code: 'IDR' }];
    const markets = makeMarkets({ list: jest.fn().mockResolvedValue(rows) });
    const svc = new AdminService(makePrisma(), makeStellar(), makeCfg(), markets, makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await expect(svc.listMarkets()).resolves.toBe(rows);
    expect(markets.list).toHaveBeenCalledTimes(1);
  });
});

describe('AdminService.updateMarket', () => {
  it('delegates straight to MarketsService.update with the same code and patch', async () => {
    const updated = { code: 'IDR', enabled: false };
    const markets = makeMarkets({ update: jest.fn().mockResolvedValue(updated) });
    const svc = new AdminService(makePrisma(), makeStellar(), makeCfg(), markets, makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    const result = await svc.updateMarket('IDR', { enabled: false } as any, 'GADMINTEST');

    expect(markets.update).toHaveBeenCalledWith('IDR', { enabled: false });
    expect(result).toBe(updated);
  });

  it('propagates MarketsService.update rejections unchanged (e.g. unknown code, bad bounds)', async () => {
    const markets = makeMarkets({
      update: jest.fn().mockRejectedValue(new BadRequestException('unknown market: ZZZ')),
    });
    const svc = new AdminService(makePrisma(), makeStellar(), makeCfg(), markets, makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);

    await expect(svc.updateMarket('ZZZ', { enabled: true } as any, 'GADMINTEST')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(markets.update).toHaveBeenCalledWith('ZZZ', { enabled: true });
  });
});

describe('AdminService.getOrderRisk', () => {
  const USER_ADDR = 'GUSER';
  const LP_ID = 'lp-1';

  const BASE_ORDER = {
    id: 'order-1',
    userAddress: USER_ADDR,
    lpId: null,
    lp: null,
    usdcAmount: 50_0000000n,
  };

  function makeRiskPrisma(
    order: any,
    counts: { userVelocity?: number; lpVelocity?: number; completed?: number; refunded?: number } = {},
  ) {
    const count = jest.fn(({ where }: any) => {
      if (where.status === 'RELEASED') return Promise.resolve(counts.completed ?? 0);
      if (where.status === 'REFUNDED') return Promise.resolve(counts.refunded ?? 0);
      if (where.lpId) return Promise.resolve(counts.lpVelocity ?? 0);
      if (where.userAddress) return Promise.resolve(counts.userVelocity ?? 0);
      return Promise.resolve(0);
    });
    return {
      order: { findUnique: jest.fn().mockResolvedValue(order), count },
      config: { findUnique: jest.fn().mockResolvedValue({ dailyLimitByTier: null }) },
    } as any;
  }

  function makeStellarWithAge(firstTxAt: string | null) {
    return { getAccountFirstTxAt: jest.fn().mockResolvedValue(firstTxAt) } as any;
  }

  it('throws NotFoundException when the order does not exist', async () => {
    const prisma = makeRiskPrisma(null);
    const svc = new AdminService(
      prisma,
      makeStellarWithAge(null),
      makeCfg(),
      makeMarkets(),
      makeUserReputation(),
      {} as any,
      { notifyOrderStatus: jest.fn() } as any,
    );

    await expect(svc.getOrderRisk('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('wallet_age_days is null (unknown) when Horizon returns 404/no first tx', async () => {
    const prisma = makeRiskPrisma(BASE_ORDER);
    const svc = new AdminService(
      prisma,
      makeStellarWithAge(null),
      makeCfg(),
      makeMarkets(),
      makeUserReputation(),
      {} as any,
      { notifyOrderStatus: jest.fn() } as any,
    );

    const risk = await svc.getOrderRisk('order-1');

    expect(risk.walletAgeDays).toBeNull();
  });

  it('wallet_age_days computes whole days since the first transaction', async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    const prisma = makeRiskPrisma(BASE_ORDER);
    const svc = new AdminService(
      prisma,
      makeStellarWithAge(tenDaysAgo),
      makeCfg(),
      makeMarkets(),
      makeUserReputation(),
      {} as any,
      { notifyOrderStatus: jest.fn() } as any,
    );

    const risk = await svc.getOrderRisk('order-1');

    expect(risk.walletAgeDays).toBe(10);
  });

  it('user/lp dispute velocity counts are queried with a 30-day disputeAt window', async () => {
    const orderWithLp = { ...BASE_ORDER, lpId: LP_ID, lp: { online: true, approvedAt: new Date(), createdAt: new Date() } };
    const prisma = makeRiskPrisma(orderWithLp, { userVelocity: 2, lpVelocity: 1 });
    const svc = new AdminService(
      prisma,
      makeStellarWithAge(null),
      makeCfg(),
      makeMarkets(),
      makeUserReputation(),
      {} as any,
      { notifyOrderStatus: jest.fn() } as any,
    );

    const risk = await svc.getOrderRisk('order-1');

    expect(risk.userDisputeVelocity30d).toBe(2);
    expect(risk.lpDisputeVelocity30d).toBe(1);
    const userCall = prisma.order.count.mock.calls.find((c: any) => c[0].where.userAddress);
    expect(userCall[0].where.disputeAt.gte).toBeInstanceOf(Date);
  });

  it('lp_dispute_velocity_30d is 0 and no lp-scoped count query fires when the order has no lpId', async () => {
    const prisma = makeRiskPrisma(BASE_ORDER);
    const svc = new AdminService(
      prisma,
      makeStellarWithAge(null),
      makeCfg(),
      makeMarkets(),
      makeUserReputation(),
      {} as any,
      { notifyOrderStatus: jest.fn() } as any,
    );

    const risk = await svc.getOrderRisk('order-1');

    expect(risk.lpDisputeVelocity30d).toBe(0);
    expect(prisma.order.count.mock.calls.some((c: any) => c[0].where.lpId)).toBe(false);
  });

  it('lp_completion is null when the order has no lpId', async () => {
    const prisma = makeRiskPrisma(BASE_ORDER);
    const svc = new AdminService(
      prisma,
      makeStellarWithAge(null),
      makeCfg(),
      makeMarkets(),
      makeUserReputation(),
      {} as any,
      { notifyOrderStatus: jest.fn() } as any,
    );

    const risk = await svc.getOrderRisk('order-1');

    expect(risk.lpCompletion).toBeNull();
  });

  it('lp_completion is populated (same shape as OrderService.getLpReputation) when the order has an lpId', async () => {
    const approvedAt = new Date('2026-01-01T00:00:00.000Z');
    const orderWithLp = {
      ...BASE_ORDER,
      lpId: LP_ID,
      lp: { online: true, approvedAt, createdAt: approvedAt },
    };
    const prisma = makeRiskPrisma(orderWithLp, { completed: 8, refunded: 2 });
    const svc = new AdminService(
      prisma,
      makeStellarWithAge(null),
      makeCfg(),
      makeMarkets(),
      makeUserReputation(),
      {} as any,
      { notifyOrderStatus: jest.fn() } as any,
    );

    const risk = await svc.getOrderRisk('order-1');

    expect(risk.lpCompletion).toEqual({
      completed_trades: 8,
      completion_rate: 0.8,
      member_since: approvedAt.toISOString(),
      online: true,
    });
  });

  it('amount_vs_tier_limit computes order/limit ratio from the user tier', async () => {
    const prisma = makeRiskPrisma(BASE_ORDER);
    const userReputation = makeUserReputation({
      personIdFor: jest.fn().mockResolvedValue('person-test'),
      getReputation: jest.fn().mockResolvedValue({
        tier: 'SILVER',
        completedTrades: 5,
        disputesLost: 0,
        completionRate: 1,
      }),
      dailyLimitBaseUnits: jest.fn().mockReturnValue(300_0000000n),
    });
    const svc = new AdminService(prisma, makeStellarWithAge(null), makeCfg(), makeMarkets(), userReputation, {} as any, { notifyOrderStatus: jest.fn() } as any);

    const risk = await svc.getOrderRisk('order-1');

    expect(risk.amountVsTierLimit).toEqual({
      orderUsdc: 50,
      tier: 'SILVER',
      dailyLimitUsdc: 300,
      ratio: 50 / 300,
    });
  });
});

describe('AdminService.getMetricsOverview', () => {
  function makeMetricsPrisma(
    opts: {
      feeRows?: { usdcAmount: bigint; platformFeeBps: number; lpFeeBps: number }[];
      flowMix?: any[];
      topLp?: any[];
      openDisputes?: number;
      dailyBars?: { day: string; volume: string }[];
      avgSecs?: number | null;
      lps?: { id: string; stellarAddress: string }[];
    } = {},
  ) {
    const order = {
      findMany: jest.fn().mockResolvedValue(opts.feeRows ?? []),
      groupBy: jest.fn((args: any) => {
        if (args.by.includes('flow')) return Promise.resolve(opts.flowMix ?? []);
        if (args.by.includes('lpId')) return Promise.resolve(opts.topLp ?? []);
        return Promise.resolve([]);
      }),
      count: jest.fn().mockResolvedValue(opts.openDisputes ?? 0),
    };
    const lp = { findMany: jest.fn().mockResolvedValue(opts.lps ?? []) };
    const $queryRaw = jest.fn((sql: any) => {
      const text = String(sql?.sql ?? sql?.text ?? sql);
      if (text.includes('date_trunc')) return Promise.resolve(opts.dailyBars ?? []);
      if (text.includes('AVG(')) return Promise.resolve([{ avg_secs: opts.avgSecs ?? null }]);
      return Promise.resolve([]);
    });
    return { order, lp, $queryRaw } as any;
  }

  function makeSvc(prisma: any) {
    return new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), {} as any, { notifyOrderStatus: jest.fn() } as any);
  }

  afterEach(() => jest.useRealTimers());

  it('rejects an unknown range with BadRequestException (defense in depth)', async () => {
    const svc = makeSvc(makeMetricsPrisma());
    await expect(svc.getMetricsOverview('1y' as any)).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ['24h', 24 * 60 * 60 * 1000],
    ['7d', 7 * 24 * 60 * 60 * 1000],
    ['30d', 30 * 24 * 60 * 60 * 1000],
  ])('range=%s maps to a since-date %d ms in the past', async (range, ms) => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-08T12:00:00.000Z'));
    const prisma = makeMetricsPrisma();
    const svc = makeSvc(prisma);

    await svc.getMetricsOverview(range as any);

    const expectedSince = new Date(Date.now() - ms);
    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ settledAt: { gte: expectedSince } }),
      }),
    );
    const flowCall = prisma.order.groupBy.mock.calls.find((c: any) => c[0].by.includes('flow'));
    expect(flowCall[0].where.settledAt).toEqual({ gte: expectedSince });
  });

  it('computes volume_usdc and fees_usdc with exact per-row BigInt bps math (no floats)', async () => {
    const prisma = makeMetricsPrisma({
      feeRows: [
        { usdcAmount: 100_0000000n, platformFeeBps: 30, lpFeeBps: 120 },
        { usdcAmount: 50_0000000n, platformFeeBps: 30, lpFeeBps: 120 },
      ],
    });
    const svc = makeSvc(prisma);

    const m = await svc.getMetricsOverview('24h');

    expect(m.volumeUsdc).toBe(150);

    expect(m.feesUsdc).toBeCloseTo(2.25, 7);
    expect(m.ordersCount).toBe(2);
  });

  it('fees math stays exact (integer base-unit division) for a bps split that would round unevenly as a float', async () => {
    const prisma = makeMetricsPrisma({
      feeRows: [{ usdcAmount: 1_0000001n, platformFeeBps: 33, lpFeeBps: 17 }],
    });
    const svc = makeSvc(prisma);

    const m = await svc.getMetricsOverview('24h');

    const expectedFeeBase = (1_0000001n * 50n) / 10_000n;
    expect(m.feesUsdc).toBeCloseTo(Number(expectedFeeBase) / 1e7, 10);
  });

  it('fees_usdc uses the SEPARATE per-fee floor sum, not a single combined-bps floor (they diverge for this input)', async () => {
    const usdcAmount = 189n;
    const platformFeeBps = 333;
    const lpFeeBps = 200;

    const separateFloorSum =
      (usdcAmount * BigInt(platformFeeBps)) / 10_000n + (usdcAmount * BigInt(lpFeeBps)) / 10_000n;
    const combinedFloor = (usdcAmount * BigInt(platformFeeBps + lpFeeBps)) / 10_000n;
    expect(separateFloorSum).toBe(9n);
    expect(combinedFloor).toBe(10n);
    expect(separateFloorSum).not.toBe(combinedFloor);

    const prisma = makeMetricsPrisma({ feeRows: [{ usdcAmount, platformFeeBps, lpFeeBps }] });
    const svc = makeSvc(prisma);

    const m = await svc.getMetricsOverview('24h');

    expect(m.feesUsdc).toBeCloseTo(Number(separateFloorSum) / 1e7, 10);
    expect(m.feesUsdc).not.toBeCloseTo(Number(combinedFloor) / 1e7, 10);
  });

  it('flow_mix reflects the groupBy(flow) shape, converting summed base units to USDC', async () => {
    const prisma = makeMetricsPrisma({
      flowMix: [
        { flow: 'TOP_UP', _sum: { usdcAmount: 200_0000000n }, _count: { _all: 4 } },
        { flow: 'WITHDRAW', _sum: { usdcAmount: 50_0000000n }, _count: { _all: 1 } },
      ],
    });
    const svc = makeSvc(prisma);

    const m = await svc.getMetricsOverview('7d');

    expect(m.flowMix).toEqual([
      { flow: 'TOP_UP', count: 4, volumeUsdc: 200 },
      { flow: 'WITHDRAW', count: 1, volumeUsdc: 50 },
    ]);
  });

  it('top_lps joins groupBy(lpId) rows with Lp.stellarAddress', async () => {
    const prisma = makeMetricsPrisma({
      topLp: [
        { lpId: 'lp-1', _sum: { usdcAmount: 300_0000000n }, _count: { _all: 6 } },
        { lpId: 'lp-2', _sum: { usdcAmount: 100_0000000n }, _count: { _all: 2 } },
      ],
      lps: [
        { id: 'lp-1', stellarAddress: 'GLP1' },
        { id: 'lp-2', stellarAddress: 'GLP2' },
      ],
    });
    const svc = makeSvc(prisma);

    const m = await svc.getMetricsOverview('30d');

    expect(m.topLps).toEqual([
      { lpId: 'lp-1', address: 'GLP1', volumeUsdc: 300, trades: 6 },
      { lpId: 'lp-2', address: 'GLP2', volumeUsdc: 100, trades: 2 },
    ]);
    expect(prisma.lp.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['lp-1', 'lp-2'] } },
      select: { id: true, stellarAddress: true },
    });
  });

  it('top_lps address is null when the Lp row is missing (defensive, should not happen in practice)', async () => {
    const prisma = makeMetricsPrisma({
      topLp: [{ lpId: 'lp-orphan', _sum: { usdcAmount: 10_0000000n }, _count: { _all: 1 } }],
      lps: [],
    });
    const svc = makeSvc(prisma);

    const m = await svc.getMetricsOverview('24h');

    expect(m.topLps).toEqual([{ lpId: 'lp-orphan', address: null, volumeUsdc: 10, trades: 1 }]);
  });

  it('does not query Lp at all when top_lps groupBy is empty (no lpIds)', async () => {
    const prisma = makeMetricsPrisma({ topLp: [] });
    const svc = makeSvc(prisma);

    await svc.getMetricsOverview('24h');

    expect(prisma.lp.findMany).not.toHaveBeenCalled();
  });

  it('daily_bars SQL uses plain date_trunc (no AT TIME ZONE) over the naive-UTC settledAt column', async () => {
    const prisma = makeMetricsPrisma();
    const svc = makeSvc(prisma);

    await svc.getMetricsOverview('24h');

    const dailyBarsCall = prisma.$queryRaw.mock.calls.find((c: any) => {
      const text = String(c[0]?.sql ?? c[0]?.text ?? c[0]);
      return text.includes('date_trunc');
    });
    expect(dailyBarsCall).toBeDefined();
    const sqlText = String(dailyBarsCall[0]?.sql ?? dailyBarsCall[0]?.text ?? dailyBarsCall[0]);
    expect(sqlText).toContain(`date_trunc('day', "settledAt")`);
    expect(sqlText).not.toContain('AT TIME ZONE');
  });

  it('daily_bars maps the $queryRaw day-bucketed rows, converting base-unit volume text to USDC', async () => {
    const prisma = makeMetricsPrisma({
      dailyBars: [
        { day: '2026-07-06', volume: '1000000000' },
        { day: '2026-07-07', volume: '500000000' },
      ],
    });
    const svc = makeSvc(prisma);

    const m = await svc.getMetricsOverview('7d');

    expect(m.dailyBars).toEqual([
      { date: '2026-07-06', volumeUsdc: 100 },
      { date: '2026-07-07', volumeUsdc: 50 },
    ]);
  });

  it('avg_settle_secs is null when there is nothing to average (SQL AVG() over zero rows)', async () => {
    const prisma = makeMetricsPrisma({ avgSecs: null });
    const svc = makeSvc(prisma);

    const m = await svc.getMetricsOverview('24h');

    expect(m.avgSettleSecs).toBeNull();
  });

  it('avg_settle_secs surfaces the $queryRaw average verbatim when data exists', async () => {
    const prisma = makeMetricsPrisma({ avgSecs: 842.5 });
    const svc = makeSvc(prisma);

    const m = await svc.getMetricsOverview('24h');

    expect(m.avgSettleSecs).toBe(842.5);
  });

  it('open_disputes counts DISPUTED with NO range filter (all-time backlog, not period-limited)', async () => {
    const prisma = makeMetricsPrisma({ openDisputes: 7 });
    const svc = makeSvc(prisma);

    const m = await svc.getMetricsOverview('24h');

    expect(m.openDisputes).toBe(7);
    expect(prisma.order.count).toHaveBeenCalledWith({ where: { status: 'DISPUTED' } });
  });

  it('empty range → zeros and empty arrays, NOT nulls (except avg_settle_secs)', async () => {
    const prisma = makeMetricsPrisma();
    const svc = makeSvc(prisma);

    const m = await svc.getMetricsOverview('24h');

    expect(m.volumeUsdc).toBe(0);
    expect(m.feesUsdc).toBe(0);
    expect(m.ordersCount).toBe(0);
    expect(m.openDisputes).toBe(0);
    expect(m.dailyBars).toEqual([]);
    expect(m.flowMix).toEqual([]);
    expect(m.topLps).toEqual([]);
    expect(m.avgSettleSecs).toBeNull();
    expect(m.range).toBe('24h');
  });
});

describe('AdminService.attestFiatPaid — the row follows the chain, and one attestation at a time', () => {
  afterEach(() => jest.restoreAllMocks());
  const ORDER = { id: 'ord-1', flow: 'TOP_UP', status: 'FUNDED', tradeId: 'a'.repeat(64), contractId: 'CESCROW', userAddress: 'GUSER', lpWallet: 'GLP', payDeadline: 4_000_000_000n, confirmDeadline: 4_000_001_800n };

  function build(attestResult: { status: string; hash: string } = { status: 'SUCCESS', hash: 'b'.repeat(64) }) {
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(ORDER),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      adminAudit: { create: jest.fn(async () => ({})) },
    } as any;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const attest = jest.fn(async () => {
      await gate;
      return attestResult;
    });
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new AdminService(prisma, makeStellar(), makeCfg(), makeMarkets(), makeUserReputation(), { attest } as any, notifications);
    return { svc, prisma, attest, release, notifications };
  }

  it('moves the row to FIAT_PAID the moment the chain accepts, so the operator and the indexer agree without a ten-second gap', async () => {
    const { svc, prisma, attest, release, notifications } = build();
    const pending = svc.attestFiatPaid('ord-1', 'GADMIN', 'BCA 12345');
    release();
    const out = await pending;
    expect(out.submission).toBe('SUCCESS');
    expect(attest).toHaveBeenCalledWith('CESCROW', 'a'.repeat(64), 4_000_001_800);
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'ord-1', status: 'FUNDED' },
      data: { status: 'FIAT_PAID' },
    });
    expect(notifications.notifyOrderStatus).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ord-1', userAddress: 'GUSER', lpWallet: 'GLP' }),
      'FIAT_PAID',
    );
    expect(prisma.order.findUnique.mock.calls[0][0].select).toEqual(
      expect.objectContaining({ userAddress: true, lpWallet: true, settledAt: true }),
    );
  });

  it('returns the success even when the notification fails, since the chain and the row already moved', async () => {
    const { svc, release, notifications } = build();
    const told = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    notifications.notifyOrderStatus.mockRejectedValue(new Error('db blip'));
    const pending = svc.attestFiatPaid('ord-1', 'GADMIN', 'BCA 12345');
    release();
    await expect(pending).resolves.toMatchObject({ submission: 'SUCCESS' });
    expect(told).toHaveBeenCalledWith(expect.stringMatching(/ord-1.*not told/));
    told.mockRestore();
  });

  it('stays silent when the other writer moved the row first, so the provider is told exactly once', async () => {
    const { svc, prisma, release, notifications } = build();
    prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
    const pending = svc.attestFiatPaid('ord-1', 'GADMIN', 'BCA 12345');
    release();
    await pending;
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('leaves the row alone when the chain refused, because nothing changed on chain', async () => {
    const { svc, prisma, release, notifications } = build({ status: 'FAILED', hash: 'c'.repeat(64) });
    const pending = svc.attestFiatPaid('ord-1', 'GADMIN', 'BCA 12345');
    release();
    await expect(pending).rejects.toBeInstanceOf(BadGatewayException);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });

  it('hands the attestor the grace end as its bound, the earlier of the confirm deadline and pay deadline plus an hour', async () => {
    const { svc, attest, release } = build();
    const pending = svc.attestFiatPaid('ord-1', 'GADMIN', 'BCA 12345');
    release();
    await pending;
    expect(attest).toHaveBeenCalledWith('CESCROW', 'a'.repeat(64), 4_000_001_800);
  });

  it('refuses a second attestation while the first is still in flight, signing once', async () => {
    const { svc, attest, release } = build();
    const first = svc.attestFiatPaid('ord-1', 'GADMIN', 'BCA 12345');
    const second = svc.attestFiatPaid('ord-1', 'GADMIN', 'BCA 12345');
    release();
    await first;
    await expect(second).rejects.toBeInstanceOf(ConflictException);
    expect(attest).toHaveBeenCalledTimes(1);
  });
});
