import { MonitoringService, MONITORING_ALERT_SCOPE } from './monitoring.service';
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
    getTradeStatus: opts.chainThrows
      ? jest.fn().mockRejectedValue(new Error('rpc down'))
      : jest.fn().mockResolvedValue(opts.chain ?? null),
    getSlashedSoFar: opts.recoveredThrows
      ? jest.fn().mockRejectedValue(new Error('rpc down'))
      : jest.fn().mockResolvedValue(opts.recovered ?? 0n),
  } as any;
  const svc = new MonitoringService(
    prisma,
    { raise: jest.fn() } as any,
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

  it('asks for the most recently settled candidates, bounded', async () => {
    const { svc, prisma } = make({ orders: [] });
    await svc.slashWindowAlerts(NOW);
    const args = prisma.order.findMany.mock.calls[0][0];
    expect(args.take).toBe(100);
    expect(args.orderBy).toEqual([{ settledAt: 'desc' }, { id: 'asc' }]);
    expect(args.where.settledAt).toEqual({ not: null });
  });

  it('is inside the scope monitoring claims, so it can be cleared', () => {
    expect(MONITORING_ALERT_SCOPE).toContain('slash_window_open');
  });
});
