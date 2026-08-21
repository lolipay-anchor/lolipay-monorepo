import { UserReputationService } from './user-reputation.service';

function makePrisma(overrides: Record<string, any> = {}) {
  const order = {
    count: jest.fn().mockResolvedValue(0),
    aggregate: jest.fn().mockResolvedValue({ _sum: { usdcAmount: null } }),
    findMany: jest.fn().mockResolvedValue([]),
    updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    ...overrides.order,
  };
  const userProfile = {
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({ address: 'GUSER', disputesLost: 1 }),
    ...overrides.userProfile,
  };

  const $transaction =
    overrides.$transaction ?? jest.fn((cb: (tx: any) => unknown) => cb({ order, userProfile }));
  return { order, userProfile, $transaction } as any;
}

describe('UserReputationService.computeTier (pure)', () => {
  const svc = new UserReputationService(makePrisma());

  it('BRONZE below the SILVER threshold', () => {
    expect(svc.computeTier(0, 0)).toBe('BRONZE');
    expect(svc.computeTier(4, 0)).toBe('BRONZE');
  });

  it('SILVER exactly at threshold 5, still SILVER at 19', () => {
    expect(svc.computeTier(5, 0)).toBe('SILVER');
    expect(svc.computeTier(19, 0)).toBe('SILVER');
  });

  it('TRUSTED exactly at threshold 20, still TRUSTED at 49', () => {
    expect(svc.computeTier(20, 0)).toBe('TRUSTED');
    expect(svc.computeTier(49, 0)).toBe('TRUSTED');
  });

  it('GOLD exactly at threshold 50 and beyond', () => {
    expect(svc.computeTier(50, 0)).toBe('GOLD');
    expect(svc.computeTier(1000, 0)).toBe('GOLD');
  });

  it('demotes one tier per lost dispute', () => {
    expect(svc.computeTier(50, 1)).toBe('TRUSTED');
    expect(svc.computeTier(50, 2)).toBe('SILVER');
    expect(svc.computeTier(50, 3)).toBe('BRONZE');
  });

  it('floors at BRONZE, never goes negative regardless of disputesLost', () => {
    expect(svc.computeTier(50, 4)).toBe('BRONZE');
    expect(svc.computeTier(50, 999)).toBe('BRONZE');
    expect(svc.computeTier(0, 5)).toBe('BRONZE');
  });

  it('ignores non-positive/garbage disputesLost defensively (never throws, never promotes)', () => {
    expect(svc.computeTier(5, 0)).toBe('SILVER');
    expect(svc.computeTier(5, -1)).toBe('SILVER');
    expect(svc.computeTier(5, NaN as any)).toBe('SILVER');
  });
});

describe('UserReputationService.getReputation', () => {
  it('computes tier/completionRate from a live RELEASED count + persisted disputesLost', async () => {
    const prisma = makePrisma({
      order: { count: jest.fn().mockResolvedValue(20) },
      userProfile: { findUnique: jest.fn().mockResolvedValue({ address: 'GUSER', disputesLost: 1 }) },
    });
    const svc = new UserReputationService(prisma);

    const rep = await svc.getReputation('GUSER');

    expect(prisma.order.count).toHaveBeenCalledWith({ where: { userAddress: 'GUSER', status: 'RELEASED' } });
    expect(rep.completedTrades).toBe(20);
    expect(rep.disputesLost).toBe(1);
    expect(rep.tier).toBe('SILVER');
    expect(rep.completionRate).toBeCloseTo(20 / 21);
  });

  it('defaults disputesLost to 0 when no UserProfile row exists (new user)', async () => {
    const prisma = makePrisma({ order: { count: jest.fn().mockResolvedValue(3) } });
    const svc = new UserReputationService(prisma);

    const rep = await svc.getReputation('GNEW');

    expect(rep.disputesLost).toBe(0);
    expect(rep.tier).toBe('BRONZE');
    expect(rep.completionRate).toBe(1);
  });

  it('completionRate is null when the user has neither completed trades nor lost disputes', async () => {
    const prisma = makePrisma();
    const svc = new UserReputationService(prisma);

    const rep = await svc.getReputation('GBRANDNEW');

    expect(rep.completionRate).toBeNull();
  });
});

describe('UserReputationService.dailyLimitBaseUnits', () => {
  const svc = new UserReputationService(makePrisma());
  const USDC = 10_000_000n;

  it('falls back to code defaults when config is null', () => {
    expect(svc.dailyLimitBaseUnits('BRONZE', null)).toBe(100n * USDC);
    expect(svc.dailyLimitBaseUnits('SILVER', null)).toBe(300n * USDC);
    expect(svc.dailyLimitBaseUnits('TRUSTED', null)).toBe(600n * USDC);
    expect(svc.dailyLimitBaseUnits('GOLD', null)).toBe(2000n * USDC);
  });

  it('falls back to code defaults when dailyLimitByTier is undefined/absent', () => {
    expect(svc.dailyLimitBaseUnits('GOLD', {})).toBe(2000n * USDC);
    expect(svc.dailyLimitBaseUnits('GOLD', undefined)).toBe(2000n * USDC);
  });

  it('uses the configured per-tier override, converted to base units', () => {
    const config = { dailyLimitByTier: { BRONZE: 500, GOLD: 50000 } };
    expect(svc.dailyLimitBaseUnits('BRONZE', config)).toBe(500n * USDC);
    expect(svc.dailyLimitBaseUnits('GOLD', config)).toBe(50000n * USDC);
  });

  it('falls back to default for a tier missing from the configured map', () => {
    const config = { dailyLimitByTier: { BRONZE: 500 } };
    expect(svc.dailyLimitBaseUnits('SILVER', config)).toBe(300n * USDC);
  });

  it('treats hostile/malformed dailyLimitByTier shapes as absent (never throws)', () => {
    expect(svc.dailyLimitBaseUnits('BRONZE', { dailyLimitByTier: 'not-an-object' as any })).toBe(100n * USDC);
    expect(svc.dailyLimitBaseUnits('BRONZE', { dailyLimitByTier: [1, 2, 3] as any })).toBe(100n * USDC);
    expect(svc.dailyLimitBaseUnits('BRONZE', { dailyLimitByTier: { BRONZE: 'nope' as any } })).toBe(100n * USDC);
    expect(svc.dailyLimitBaseUnits('BRONZE', { dailyLimitByTier: { BRONZE: -5 } })).toBe(100n * USDC);
    expect(svc.dailyLimitBaseUnits('BRONZE', { dailyLimitByTier: null })).toBe(100n * USDC);
  });
});

describe('UserReputationService.used24hBaseUnits', () => {
  it('filters by userAddress, 24h window, and excludes terminal-failed statuses', async () => {
    const prisma = makePrisma({
      order: { aggregate: jest.fn().mockResolvedValue({ _sum: { usdcAmount: 12345n } }) },
    });
    const svc = new UserReputationService(prisma);

    const used = await svc.used24hBaseUnits('GUSER');

    expect(used).toBe(12345n);
    const call = prisma.order.aggregate.mock.calls[0][0];
    expect(call.where.userAddress).toBe('GUSER');
    expect(call.where.status.notIn.sort()).toEqual(['CANCELLED', 'EXPIRED', 'REFUNDED'].sort());
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
  });

  it('returns 0n when the sum is null (no orders in window)', async () => {
    const prisma = makePrisma({
      order: { aggregate: jest.fn().mockResolvedValue({ _sum: { usdcAmount: null } }) },
    });
    const svc = new UserReputationService(prisma);

    expect(await svc.used24hBaseUnits('GUSER')).toBe(0n);
  });

  it('reads through an explicitly-passed client (e.g. a transaction client) instead of the default this.prisma', async () => {
    const defaultPrisma = makePrisma({
      order: { aggregate: jest.fn().mockResolvedValue({ _sum: { usdcAmount: 999n } }) },
    });
    const svc = new UserReputationService(defaultPrisma);

    const txClient = makePrisma({
      order: { aggregate: jest.fn().mockResolvedValue({ _sum: { usdcAmount: 42n } }) },
    });

    const used = await svc.used24hBaseUnits('GUSER', txClient as any);

    expect(used).toBe(42n);
    expect(txClient.order.aggregate).toHaveBeenCalledTimes(1);
    expect(defaultPrisma.order.aggregate).not.toHaveBeenCalled();
  });
});

describe('UserReputationService.recordDisputeLost (M3 fix: per-order idempotent)', () => {
  it('flips Order.disputeLossAccrued false→true, then upserts an atomic increment', async () => {
    const prisma = makePrisma({ order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } });
    const svc = new UserReputationService(prisma);

    await svc.recordDisputeLost('GUSER', 'order-1');

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', disputeLossAccrued: false },
      data: { disputeLossAccrued: true },
    });
    expect(prisma.userProfile.upsert).toHaveBeenCalledWith({
      where: { address: 'GUSER' },
      update: { disputesLost: { increment: 1 } },
      create: { address: 'GUSER', disputesLost: 1 },
    });
  });

  it('a second call for the SAME orderId (already accrued) does NOT double-increment', async () => {
    const prisma = makePrisma({
      order: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 0 }),
      },
    });
    const svc = new UserReputationService(prisma);

    await svc.recordDisputeLost('GUSER', 'order-1');
    await svc.recordDisputeLost('GUSER', 'order-1');

    expect(prisma.order.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.userProfile.upsert).toHaveBeenCalledTimes(1);
  });

  it('a fresh order (never accrued) increments exactly once', async () => {
    const prisma = makePrisma({ order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } });
    const svc = new UserReputationService(prisma);

    await svc.recordDisputeLost('GUSER', 'order-fresh');

    expect(prisma.userProfile.upsert).toHaveBeenCalledTimes(1);
  });

  it('DIFFERENT orders for the same user each accrue independently (not conflated by orderId)', async () => {
    const prisma = makePrisma({ order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } });
    const svc = new UserReputationService(prisma);

    await svc.recordDisputeLost('GUSER', 'order-A');
    await svc.recordDisputeLost('GUSER', 'order-B');

    expect(prisma.userProfile.upsert).toHaveBeenCalledTimes(2);
  });

  it('wraps the flip + increment in a single prisma.$transaction call', async () => {
    const prisma = makePrisma({ order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } });
    const svc = new UserReputationService(prisma);

    await svc.recordDisputeLost('GUSER', 'order-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('UserReputationService.recordDisputeLost — atomicity (L-A fix)', () => {
  it('rolls back the disputeLossAccrued flip when the increment throws, so a re-delivery can retry and succeed', async () => {
    let committedAccrued = false;
    let committedDisputesLost = 0;
    let failNextUpsert = true;

    const prisma = {
      $transaction: async (cb: (tx: any) => Promise<unknown>) => {
        let workingAccrued = committedAccrued;
        let workingDisputesLost = committedDisputesLost;
        const tx = {
          order: {
            updateMany: async (args: any) => {
              if (args.where.disputeLossAccrued === false && !workingAccrued) {
                workingAccrued = true;
                return { count: 1 };
              }
              return { count: 0 };
            },
          },
          userProfile: {
            upsert: async () => {
              if (failNextUpsert) {
                failNextUpsert = false;
                throw new Error('simulated DB crash between flip and increment');
              }
              workingDisputesLost += 1;
              return { disputesLost: workingDisputesLost };
            },
          },
        };
        const result = await cb(tx);
        committedAccrued = workingAccrued;
        committedDisputesLost = workingDisputesLost;
        return result;
      },
    } as any;
    const svc = new UserReputationService(prisma);

    await expect(svc.recordDisputeLost('GUSER', 'order-1')).rejects.toThrow(
      'simulated DB crash between flip and increment',
    );
    expect(committedAccrued).toBe(false);
    expect(committedDisputesLost).toBe(0);

    await svc.recordDisputeLost('GUSER', 'order-1');
    expect(committedAccrued).toBe(true);
    expect(committedDisputesLost).toBe(1);
  });

  it('never calls the increment when the flip did not apply (already-accrued/concurrent case) — nothing to roll back', async () => {
    const upsert = jest.fn();
    const prisma = {
      $transaction: async (cb: (tx: any) => Promise<unknown>) =>
        cb({
          order: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
          userProfile: { upsert },
        }),
    } as any;
    const svc = new UserReputationService(prisma);

    await svc.recordDisputeLost('GUSER', 'order-1');

    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('UserReputationService.backfillDisputesLost', () => {
  it('is a no-op when there is no dispute history (prod-launch case)', async () => {
    const prisma = makePrisma({ order: { findMany: jest.fn().mockResolvedValue([]) } });
    const svc = new UserReputationService(prisma);

    await svc.backfillDisputesLost();

    expect(prisma.userProfile.upsert).not.toHaveBeenCalled();
  });

  it('sets the exact per-user count from mapped lost-dispute orders (TOP_UP refunded, WITHDRAW released)', async () => {
    const prisma = makePrisma({
      order: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'o1', userAddress: 'GALICE' },
          { id: 'o2', userAddress: 'GALICE' },
          { id: 'o3', userAddress: 'GBOB' },
        ]),
      },
    });
    const svc = new UserReputationService(prisma);

    await svc.backfillDisputesLost();

    expect(prisma.userProfile.upsert).toHaveBeenCalledWith({
      where: { address: 'GALICE' },
      update: { disputesLost: 2 },
      create: { address: 'GALICE', disputesLost: 2 },
    });
    expect(prisma.userProfile.upsert).toHaveBeenCalledWith({
      where: { address: 'GBOB' },
      update: { disputesLost: 1 },
      create: { address: 'GBOB', disputesLost: 1 },
    });

    const call = prisma.order.findMany.mock.calls[0][0];
    expect(call.where.resolution).toEqual({ not: null });
    expect(call.where.status).toEqual({ in: ['RELEASED', 'REFUNDED'] });
    expect(call.where.OR).toEqual([
      { flow: 'TOP_UP', resolution: 'refunded' },
      { flow: 'WITHDRAW', resolution: 'released' },
    ]);
  });

  it('counts an order resolved WITHOUT disputeAt ever being stamped (M-A fix: missed disputed event)', async () => {
    const prisma = makePrisma({
      order: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'o-missed-dispute', userAddress: 'GALICE', disputeAt: null, resolution: 'refunded' },
        ]),
      },
    });
    const svc = new UserReputationService(prisma);

    await svc.backfillDisputesLost();

    expect(prisma.userProfile.upsert).toHaveBeenCalledWith({
      where: { address: 'GALICE' },
      update: { disputesLost: 1 },
      create: { address: 'GALICE', disputesLost: 1 },
    });
  });

  it('live accrual and backfill agree on an order that never had disputeAt stamped — no tier flip across a simulated reboot', async () => {
    const prisma = makePrisma({
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([
          { id: 'order-cold-restart', userAddress: 'GALICE', disputeAt: null, resolution: 'refunded' },
        ]),
      },
    });
    const svc = new UserReputationService(prisma);

    await svc.recordDisputeLost('GALICE', 'order-cold-restart');
    expect(prisma.userProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { disputesLost: { increment: 1 } } }),
    );
    prisma.userProfile.upsert.mockClear();

    await svc.backfillDisputesLost();

    expect(prisma.userProfile.upsert).toHaveBeenCalledWith({
      where: { address: 'GALICE' },
      update: { disputesLost: 1 },
      create: { address: 'GALICE', disputesLost: 1 },
    });
  });

  it('marks disputeLossAccrued=true for every order it counted', async () => {
    const prisma = makePrisma({
      order: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'o1', userAddress: 'GALICE' },
          { id: 'o2', userAddress: 'GBOB' },
        ]),
      },
    });
    const svc = new UserReputationService(prisma);

    await svc.backfillDisputesLost();

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['o1', 'o2'] } },
      data: { disputeLossAccrued: true },
    });
  });

  it('does not touch Order.disputeLossAccrued when there is nothing to backfill', async () => {
    const prisma = makePrisma({ order: { findMany: jest.fn().mockResolvedValue([]) } });
    const svc = new UserReputationService(prisma);

    await svc.backfillDisputesLost();

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('is idempotent: re-running sets (not increments) the same exact value', async () => {
    const prisma = makePrisma({
      order: { findMany: jest.fn().mockResolvedValue([{ id: 'o1', userAddress: 'GALICE' }]) },
    });
    const svc = new UserReputationService(prisma);

    await svc.backfillDisputesLost();
    await svc.backfillDisputesLost();

    expect(prisma.userProfile.upsert).toHaveBeenNthCalledWith(1, {
      where: { address: 'GALICE' },
      update: { disputesLost: 1 },
      create: { address: 'GALICE', disputesLost: 1 },
    });
    expect(prisma.userProfile.upsert).toHaveBeenNthCalledWith(2, {
      where: { address: 'GALICE' },
      update: { disputesLost: 1 },
      create: { address: 'GALICE', disputesLost: 1 },
    });
  });

  it('agrees with a prior live recordDisputeLost accrual for the same order — no flip across a reboot', async () => {
    const prisma = makePrisma({
      order: { findMany: jest.fn().mockResolvedValue([{ id: 'order-1', userAddress: 'GALICE' }]) },
    });
    const svc = new UserReputationService(prisma);

    await svc.recordDisputeLost('GALICE', 'order-1');
    prisma.userProfile.upsert.mockClear();

    await svc.backfillDisputesLost();

    expect(prisma.userProfile.upsert).toHaveBeenCalledWith({
      where: { address: 'GALICE' },
      update: { disputesLost: 1 },
      create: { address: 'GALICE', disputesLost: 1 },
    });
  });

  it('runs automatically from onModuleInit (boot backfill)', async () => {
    const prisma = makePrisma({
      order: { findMany: jest.fn().mockResolvedValue([{ id: 'o1', userAddress: 'GALICE' }]) },
    });
    const svc = new UserReputationService(prisma);
    const spy = jest.spyOn(svc, 'backfillDisputesLost');

    await svc.onModuleInit();

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('UserReputationService.onModuleInit — boot safety', () => {
  it('does not reject onModuleInit when backfillDisputesLost throws — logs a warning and continues', async () => {
    const prisma = makePrisma({ order: { findMany: jest.fn().mockRejectedValue(new Error('db unavailable')) } });
    const svc = new UserReputationService(prisma);
    const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await expect(svc.onModuleInit()).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('db unavailable');
  });

  it('still resolves cleanly (no warning) when backfillDisputesLost succeeds', async () => {
    const prisma = makePrisma({ order: { findMany: jest.fn().mockResolvedValue([]) } });
    const svc = new UserReputationService(prisma);
    const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => undefined);

    await expect(svc.onModuleInit()).resolves.toBeUndefined();

    expect(warnSpy).not.toHaveBeenCalled();
  });
});
