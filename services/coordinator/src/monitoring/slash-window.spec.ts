import { MonitoringService, MONITORING_ALERT_SCOPE } from './monitoring.service';
import { DiditRefusalsService } from './didit-refusals.service';

const knownRefusals = () => {
  const r = new DiditRefusalsService();
  r.workflowPerformsAml(false);
  return r;
};
import { Alert } from './alerts.service';

const NOW = new Date('2026-08-26T12:00:00Z');
const nowSecs = Math.floor(NOW.getTime() / 1000);

function make(opts: {
  orders?: any[];
  chain?: any;
  chainThrows?: boolean;
  recovered?: bigint;
  recoveredThrows?: boolean;
}) {
  const prisma = {
    order: { findMany: jest.fn().mockResolvedValue(opts.orders ?? []) },
  } as any;
  const stellar = {
    getTradeStatusStrict: opts.chainThrows
      ? jest.fn().mockRejectedValue(new Error('rpc down'))
      : jest.fn().mockResolvedValue(opts.chain ?? null),
    getTradeStatus: jest.fn().mockResolvedValue(opts.chain ?? null),
    getSlashedSoFar: opts.recoveredThrows
      ? jest.fn().mockRejectedValue(new Error('rpc down'))
      : jest.fn().mockResolvedValue(opts.recovered ?? 0n),
  } as any;
  const svc = new MonitoringService(prisma, { raise: jest.fn() } as any, knownRefusals(),
    { stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })), prune: jest.fn() } as any,
    stellar,
    { escrowContractId: 'CESCROW' } as any,
  );
  return { svc, prisma, stellar };
}

const order = (over: any = {}) => ({
  id: 'ord-1',
  tradeId: 'a'.repeat(64),
  contractId: 'CESCROW',
  usdcAmount: BigInt('1000000000'),
  ...over,
});

const verdict = (over: any = {}) => ({
  status: 'RELEASED',
  settledAt: 0,
  liabilityEstablished: true,
  slashDeadline: BigInt(nowSecs + 3600),
  ...over,
});

describe('a verdict with a clock running reaches a person', () => {
  it('raises an urgent alert naming the order, the money and the minutes left', async () => {
    const { svc } = make({ orders: [order()], chain: verdict() });
    const alerts = await svc.slashWindowAlerts(NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe('slash_window_open:ord-1');
    expect(alerts[0].urgency).toBe('urgent');
    expect(alerts[0].text).toContain('60 minute');
    expect(alerts[0].text).toContain('1000000000');
    expect(alerts[0].text).toContain('nothing recovers this automatically');
  });

  it('says nothing when no liability has been established', async () => {
    const { svc } = make({
      orders: [order()],
      chain: verdict({ liabilityEstablished: false }),
    });
    expect(await svc.slashWindowAlerts(NOW)).toEqual([]);
  });

  it('says nothing once the window has closed', async () => {
    const { svc } = make({
      orders: [order()],
      chain: verdict({ slashDeadline: BigInt(nowSecs - 1) }),
    });
    expect(await svc.slashWindowAlerts(NOW)).toEqual([]);
  });

  it('says nothing when an exonerating verdict zeroed the window', async () => {
    const { svc } = make({ orders: [order()], chain: verdict({ slashDeadline: 0n }) });
    expect(await svc.slashWindowAlerts(NOW)).toEqual([]);
  });

  it('stops once the trade has been recovered in full', async () => {
    const { svc } = make({
      orders: [order()],
      chain: verdict(),
      recovered: BigInt('1000000000'),
    });
    expect(await svc.slashWindowAlerts(NOW)).toEqual([]);
  });

  it('keeps alerting while only part has been recovered, and says what is left', async () => {
    const { svc } = make({
      orders: [order()],
      chain: verdict(),
      recovered: BigInt('400000000'),
    });
    const alerts = await svc.slashWindowAlerts(NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain('600000000');
  });

  it('escalates its fingerprint as the window narrows, so the reminder re-fires', async () => {
    const wide = await make({
      orders: [order()],
      chain: verdict({ slashDeadline: BigInt(nowSecs + 5 * 3600) }),
    }).svc.slashWindowAlerts(NOW);
    const tight = await make({
      orders: [order()],
      chain: verdict({ slashDeadline: BigInt(nowSecs + 600) }),
    }).svc.slashWindowAlerts(NOW);
    expect(wide[0].fingerprint).not.toBe(tight[0].fingerprint);
    expect(tight[0].fingerprint).toBe('under-15m');
  });

  it('does not repeat itself while the window stays in the same band', async () => {
    const a = await make({
      orders: [order()],
      chain: verdict({ slashDeadline: BigInt(nowSecs + 1800) }),
    }).svc.slashWindowAlerts(NOW);
    const b = await make({
      orders: [order()],
      chain: verdict({ slashDeadline: BigInt(nowSecs + 2400) }),
    }).svc.slashWindowAlerts(NOW);
    expect(a[0].fingerprint).toBe(b[0].fingerprint);
  });

  it('skips an order it could not read rather than claiming it is fine', async () => {
    const { svc } = make({ orders: [order()], chainThrows: true });
    expect(await svc.slashWindowAlerts(NOW)).toEqual([]);
  });

  it('skips an order whose recovered total it could not read', async () => {
    const { svc } = make({ orders: [order()], chain: verdict(), recoveredThrows: true });
    expect(await svc.slashWindowAlerts(NOW)).toEqual([]);
  });

  it('asks the database for open windows directly, rather than guessing a horizon', async () => {
    const { svc, prisma } = make({ orders: [] });
    await svc.slashWindowAlerts(NOW);
    const args = prisma.order.findMany.mock.calls[0][0];
    expect(args.take).toBe(100);
    expect(args.where.liabilityEstablished).toBe(true);
    expect(args.where.slashDeadline.gt).toBe(BigInt(Math.floor(NOW.getTime() / 1000)));
  });

  it('does not filter on when a trade settled, because a verdict can arrive far later', async () => {
    const { svc, prisma } = make({ orders: [] });
    await svc.slashWindowAlerts(NOW);
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))).not.toContain('settledAt');
  });

  it('takes the oldest first, because the window closing soonest matters most', async () => {
    const { svc, prisma } = make({ orders: [] });
    await svc.slashWindowAlerts(NOW);
    expect(prisma.order.findMany.mock.calls[0][0].orderBy[0]).toEqual({ settledAt: 'asc' });
  });

  it('is inside the scope monitoring claims, so it can be cleared', () => {
    expect(MONITORING_ALERT_SCOPE).toContain('slash_window_open');
  });
});

describe('a scan that could not see everything must not report anything cleared', () => {
  function svcWith(opts: Parameters<typeof make>[0]) {
    return make(opts).svc;
  }

  const metrics = {
    generated_at: 'now',
    orders_by_status: {},
    open_disputes: 0,
    release_overdue: 0,
    fiat_payment_overdue: 0,
    indexer_lag_seconds: 5,
  };

  function full() {
    const orders = Array.from({ length: 100 }, (_, i) => order({ id: `o${i}` }));
    return make({ orders, chain: verdict({ liabilityEstablished: false }) });
  }

  it('says so when the scan came back at its limit', async () => {
    const alerts = await full().svc.slashWindowAlerts(NOW);
    const over = alerts.find((a: Alert) => a.key === 'slash_window_open:overflow');
    expect(over).toBeDefined();
    expect(over!.urgency).toBe('urgent');
    expect(over!.text).toContain('truncated');
  });

  it('marks the family incomplete when the scan came back at its limit', async () => {
    const incomplete = new Set<string>();
    await full().svc.slashWindowAlerts(NOW, incomplete);
    expect(incomplete.has('slash_window_open')).toBe(true);
  });

  it('marks the family incomplete when a trade could not be read', async () => {
    const incomplete = new Set<string>();
    await svcWith({ orders: [order()], chainThrows: true }).slashWindowAlerts(NOW, incomplete);
    expect(incomplete.has('slash_window_open')).toBe(true);
  });

  it('marks the family incomplete when the recovered total could not be read', async () => {
    const incomplete = new Set<string>();
    await svcWith({
      orders: [order()],
      chain: verdict(),
      recoveredThrows: true,
    }).slashWindowAlerts(NOW, incomplete);
    expect(incomplete.has('slash_window_open')).toBe(true);
  });

  it('leaves the family complete on a clean, unfilled scan', async () => {
    const incomplete = new Set<string>();
    await svcWith({ orders: [order()], chain: verdict() }).slashWindowAlerts(NOW, incomplete);
    expect(incomplete.has('slash_window_open')).toBe(false);
  });
});

describe('two ticks must not be able to wipe each other findings', () => {
  const metrics = {
    generated_at: 'now',
    orders_by_status: {},
    open_disputes: 0,
    release_overdue: 0,
    fiat_payment_overdue: 0,
    indexer_lag_seconds: 5,
  };

  function slowSvc(delayMs: number) {
    const raise = jest.fn(async () => ({ sent: [], cleared: [] }));
    let calls = 0;
    const prisma = {
      order: {
        findMany: jest.fn(async () => {
          await new Promise((r) => setTimeout(r, delayMs));
          calls += 1;
          return [{ ...order(), disputeAt: NOW, createdAt: NOW }];
        }),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      config: { findUnique: jest.fn().mockResolvedValue({ payWindowSecs: 1800, confirmWindowSecs: 1800 }) },
      indexerState: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date() }) },
      kycVerification: { count: jest.fn().mockResolvedValue(0) },
      lp: { count: jest.fn().mockResolvedValue(1) },
    } as any;
    const stellar = {
      getTradeStatusStrict: jest.fn().mockRejectedValue(new Error('rpc down')),
      getTradeStatus: jest.fn().mockResolvedValue(null),
      getSlashedSoFar: jest.fn().mockResolvedValue(0n),
    } as any;
    const svc = new MonitoringService(prisma, { raise } as any, knownRefusals(),
      { stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })), prune: jest.fn() } as any,
      stellar,
      { escrowContractId: 'CESCROW' } as any,
    );
    return { svc, raise, callCount: () => calls };
  }

  it('refuses to start a second tick while the first is still running', async () => {
    const { svc, raise } = slowSvc(40);
    await Promise.all([svc.checkAndAlert(), svc.checkAndAlert(), svc.checkAndAlert()]);
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('carries its own incomplete set, so an overlapping run cannot empty it', async () => {
    const { svc, raise } = slowSvc(5);
    await svc.checkAndAlert();
    await svc.checkAndAlert();
    for (const call of raise.mock.calls) {
      const incomplete = (call as any[])[2];
      expect(incomplete.has('slash_window_open')).toBe(true);
    }
  });

  it('does not keep the set between ticks, so a cleared problem can be reported', async () => {
    const raise = jest.fn(async () => ({ sent: [], cleared: [] }));
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      config: { findUnique: jest.fn().mockResolvedValue({ payWindowSecs: 1800, confirmWindowSecs: 1800 }) },
      indexerState: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date() }) },
      kycVerification: { count: jest.fn().mockResolvedValue(0) },
      lp: { count: jest.fn().mockResolvedValue(1) },
    } as any;
    const svc = new MonitoringService(prisma, { raise } as any, knownRefusals(),
      { stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })), prune: jest.fn() } as any,
      { getTradeStatusStrict: jest.fn(), getTradeStatus: jest.fn(), getSlashedSoFar: jest.fn(), stakingCooldownSecs: jest.fn(async () => 349_201) } as any,
      { escrowContractId: 'CESCROW' } as any,
    );
    await svc.checkAndAlert();
    expect(((raise.mock.calls[0] as any[])[2] as Set<string>).size).toBe(0);
  });
});

describe('a verdict reached long after settlement is still found', () => {
  it('alerts on a window opened a year after the trade settled', async () => {
    const yearAgo = new Date(NOW.getTime() - 365 * 24 * 60 * 60 * 1000);
    const { svc } = make({
      orders: [{ ...order(), settledAt: yearAgo }],
      chain: verdict({ slashDeadline: BigInt(nowSecs + 3600) }),
    });
    const alerts = await svc.slashWindowAlerts(NOW);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe('slash_window_open:ord-1');
  });
});

describe('the restitution scan cannot clear while the thing that feeds it is behind', () => {
  const base = {
    generated_at: 'now',
    orders_by_status: {},
    open_disputes: 0,
    release_overdue: 0,
    fiat_payment_overdue: 0,
  };

  function monitoring() {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      config: { findUnique: jest.fn().mockResolvedValue({ payWindowSecs: 1800, confirmWindowSecs: 1800 }) },
      indexerState: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date() }) },
      kycVerification: { count: jest.fn().mockResolvedValue(0) },
      lp: { count: jest.fn().mockResolvedValue(1) },
    } as any;
    return new MonitoringService(prisma, { raise: jest.fn() } as any, knownRefusals(),
      { stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })), prune: jest.fn(async () => 0) } as any,
      { getTradeStatus: jest.fn(async () => null), getSlashedSoFar: jest.fn(async () => 0n), stakingCooldownSecs: jest.fn(async () => 349_201) } as any,
      { escrowContractId: 'CESCROW' } as any,
    );
  }

  it('marks the slash family incomplete when the indexer is lagging', async () => {
    const incomplete = new Set<string>();
    await monitoring().buildAlerts({ ...base, indexer_lag_seconds: 6000 } as any, incomplete);
    expect(incomplete.has('slash_window_open')).toBe(true);
  });

  it('marks it incomplete when the indexer has never run at all', async () => {
    const incomplete = new Set<string>();
    await monitoring().buildAlerts({ ...base, indexer_lag_seconds: null } as any, incomplete);
    expect(incomplete.has('slash_window_open')).toBe(true);
  });

  it('treats a stalled indexer as urgent, because four detectors go blind behind it', async () => {
    const lagging = await monitoring().buildAlerts({ ...base, indexer_lag_seconds: 6000 } as any);
    const never = await monitoring().buildAlerts({ ...base, indexer_lag_seconds: null } as any);

    expect(lagging.find((a) => a.key === 'indexer_stalled')?.urgency).toBe('urgent');
    expect(never.find((a) => a.key === 'indexer_stalled')?.urgency).toBe('urgent');
  });

  it('raises when the deployed cooldown has fallen below the floor these windows need', async () => {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      config: { findUnique: jest.fn().mockResolvedValue({ payWindowSecs: 1800, confirmWindowSecs: 1800 }) },
      indexerState: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date() }) },
      kycVerification: { count: jest.fn().mockResolvedValue(0) },
      lp: { count: jest.fn().mockResolvedValue(1) },
    } as any;
    const svc = new MonitoringService(prisma, { raise: jest.fn() } as any, knownRefusals(),
      { stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })), prune: jest.fn(async () => 0) } as any,
      {
        getTradeStatus: jest.fn(async () => null),
        getSlashedSoFar: jest.fn(async () => 0n),
        stakingCooldownSecs: jest.fn(async () => 345_601),
      } as any,
      { escrowContractId: 'CESCROW' } as any,
    );

    const alerts = await svc.buildAlerts({ ...base, indexer_lag_seconds: 5 } as any);
    const found = alerts.find((a) => a.key === 'cooldown_below_floor');
    expect(found?.urgency).toBe('urgent');
    expect(found?.text).toContain('349201');
  });

  it('leaves it complete when the indexer is keeping up', async () => {
    const incomplete = new Set<string>();
    await monitoring().buildAlerts({ ...base, indexer_lag_seconds: 5 } as any, incomplete);
    expect(incomplete.has('slash_window_open')).toBe(false);
  });
});

describe('the anchor is watched for disagreeing with itself', () => {
  const base = {
    generated_at: 'now',
    orders_by_status: {},
    open_disputes: 0,
    release_overdue: 0,
    fiat_payment_overdue: 0,
    indexer_lag_seconds: 5,
  };

  function monitoring(check: () => Promise<string[]>) {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      config: { findUnique: jest.fn().mockResolvedValue({ payWindowSecs: 1800, confirmWindowSecs: 1800 }) },
      indexerState: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date() }) },
      kycVerification: { count: jest.fn().mockResolvedValue(0) },
      lp: { count: jest.fn().mockResolvedValue(1) },
    } as any;
    const svc = new MonitoringService(prisma, { raise: jest.fn() } as any, knownRefusals(),
      { stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })), prune: jest.fn(async () => 0) } as any,
      {
        getTradeStatus: jest.fn(async () => null),
        getSlashedSoFar: jest.fn(async () => 0n),
        stakingCooldownSecs: jest.fn(async () => 432_000),
      } as any,
      { escrowContractId: 'CESCROW', anchorHomeDomain: 'lolipay.app' } as any,
    );
    (svc as any).checkAnchor = check;
    return svc;
  }

  it('raises when the toml and the live challenge name different signing keys', async () => {
    const alerts = await monitoring(async () => [
      'the toml advertises SIGNING_KEY GBS7 but the challenge is sourced by GA3H',
    ]).buildAlerts(base as any);

    const found = alerts.find((a) => a.key.startsWith('anchor_identity'));
    expect(found?.urgency).toBe('urgent');
    expect(found?.text).toContain('GBS7');
  });

  it('says nothing when the anchor agrees with itself', async () => {
    const alerts = await monitoring(async () => []).buildAlerts(base as any);
    expect(alerts.find((a) => a.key.startsWith('anchor_identity'))).toBeUndefined();
  });

  it('marks the family incomplete when it could not reach the anchor at all', async () => {
    const incomplete = new Set<string>();
    await monitoring(async () => {
      throw new Error('connection refused');
    }).buildAlerts(base as any, incomplete);

    expect(incomplete.has('anchor_identity')).toBe(true);
  });
});
