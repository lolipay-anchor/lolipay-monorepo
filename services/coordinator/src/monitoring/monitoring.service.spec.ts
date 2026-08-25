import { MonitoringService, MONITORING_ALERT_SCOPE } from './monitoring.service';

function rows(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, tradeId: `t${prefix}${i}` }));
}

function make(opts: {
  disputes: number;
  releaseOverdue: number;
  fiatOverdue: number;
  indexerAgeMs: number | null;
  webhook?: string;
}) {
  const prisma = {
    order: {
      groupBy: jest
        .fn()
        .mockResolvedValue([
          { status: 'FUNDED', _count: { _all: 3 } },
          { status: 'DISPUTED', _count: { _all: opts.disputes } },
        ]),
      count: jest
        .fn()
        .mockResolvedValueOnce(opts.disputes)
        .mockResolvedValueOnce(opts.releaseOverdue)
        .mockResolvedValueOnce(opts.fiatOverdue),
      findMany: jest
        .fn()
        .mockResolvedValueOnce(rows('d', opts.disputes))
        .mockResolvedValueOnce(rows('r', opts.releaseOverdue))
        .mockResolvedValueOnce(rows('f', opts.fiatOverdue)),
    },
    indexerState: {
      findUnique: jest.fn().mockResolvedValue(
        opts.indexerAgeMs == null ? null : { updatedAt: new Date(Date.now() - opts.indexerAgeMs) },
      ),
    },
  } as any;
  const raised: any[] = [];
  const alerts = {
    raise: jest.fn(async (scope: string[], list: any[], incomplete: Set<string>) => {
      raised.push({ scope, list, incomplete });
      return { sent: list, cleared: [] };
    }),
  } as any;
  return { svc: new MonitoringService(prisma, alerts), prisma, alerts, raised };
}

describe('MonitoringService', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('metrics() reports counts, disputes, overdue, and indexer lag', async () => {
    const { svc } = make({ disputes: 2, releaseOverdue: 1, fiatOverdue: 0, indexerAgeMs: 8000 });
    const m = await svc.metrics();
    expect(m.orders_by_status).toEqual({ FUNDED: 3, DISPUTED: 2 });
    expect(m.open_disputes).toBe(2);
    expect(m.release_overdue).toBe(1);
    expect(m.fiat_payment_overdue).toBe(0);
    expect(m.indexer_lag_seconds).toBeGreaterThanOrEqual(7);
    expect(m.indexer_lag_seconds).toBeLessThanOrEqual(9);
  });

  it('hands a tripped threshold to the alerts service, naming the order and its trade', async () => {
    const { svc, alerts, raised } = make({
      disputes: 1,
      releaseOverdue: 0,
      fiatOverdue: 0,
      indexerAgeMs: 5000,
    });
    await svc.checkAndAlert();

    expect(alerts.raise).toHaveBeenCalledTimes(1);
    const texts = raised[0].list.map((x: any) => x.text).join(' ');
    expect(texts).toMatch(/disputed/i);
    expect(texts).toContain('d0');
    expect(texts).toContain('td0');
    expect(raised[0].list[0].key).toBe('open_dispute:d0');
  });

  it('claims only the conditions it owns, so it cannot clear another detector', async () => {
    const { svc, raised } = make({
      disputes: 1,
      releaseOverdue: 0,
      fiatOverdue: 0,
      indexerAgeMs: 5000,
    });
    await svc.checkAndAlert();
    expect(raised[0].scope).toEqual(MONITORING_ALERT_SCOPE);
    expect(raised[0].scope).not.toContain('escrow_divergence');
  });

  it('still calls the alerts service when all is clear, so a cleared condition is reported', async () => {
    const { svc, alerts, raised } = make({
      disputes: 0,
      releaseOverdue: 0,
      fiatOverdue: 0,
      indexerAgeMs: 5000,
    });
    await svc.checkAndAlert();
    expect(alerts.raise).toHaveBeenCalledTimes(1);
    expect(raised[0].list).toEqual([]);
  });

  it('raises nothing at all when the conditions cannot be read, rather than an empty set', async () => {
    const { svc, alerts, prisma } = make({
      disputes: 1,
      releaseOverdue: 0,
      fiatOverdue: 0,
      indexerAgeMs: 5000,
    });
    prisma.order.findMany = jest.fn().mockRejectedValue(new Error('db down'));
    await svc.checkAndAlert();
    expect(alerts.raise).not.toHaveBeenCalled();
  });

  it('alerts when the indexer has never run', async () => {
    const { svc, raised } = make({
      disputes: 0,
      releaseOverdue: 0,
      fiatOverdue: 0,
      indexerAgeMs: null,
    });
    await svc.checkAndAlert();
    expect(raised[0].list.map((x: any) => x.text).join(' ')).toMatch(/indexer has never run/i);
  });
});
