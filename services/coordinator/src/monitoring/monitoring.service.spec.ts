import { MonitoringService, MONITORING_ALERT_SCOPE } from './monitoring.service';
import { DiditRefusalsService } from './didit-refusals.service';

function rows(prefix: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i}`,
    tradeId: `t${prefix}${i}`,
    disputeAt: new Date(),
    createdAt: new Date(),
  }));
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
  const refusals = new DiditRefusalsService();
  return { refusals, svc: new MonitoringService(prisma, alerts, refusals, { stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })), prune: jest.fn(async () => 0) } as any, { getTradeStatus: jest.fn(async () => null), getSlashedSoFar: jest.fn(async () => 0n) } as any, { escrowContractId: 'CESCROW' } as any), prisma, alerts, raised };
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

describe('an operator can tell an outage, a probe and a spending ceiling apart', () => {
  const keyOf = (raised: any[]) => raised.flatMap((r) => r.list.map((a: any) => a.key));
  const quiet = () =>
    make({ disputes: 0, releaseOverdue: 0, fiatOverdue: 0, indexerAgeMs: 1000 });

  it('raises nothing about identity verification while nothing has gone wrong', async () => {
    const { svc, raised } = quiet();
    await svc.checkAndAlert();
    expect(keyOf(raised).filter((k: string) => k.startsWith('didit_'))).toEqual([]);
  });

  it('raises an urgent alert when a delivery this anchor trusted could not be acted on', async () => {
    const { svc, raised, refusals } = quiet();
    refusals.record('a delivery named no customer this anchor can read');
    await svc.checkAndAlert();
    const alert = raised.flatMap((r) => r.list).find((a: any) => a.key === 'didit_deliveries_refused');
    expect(alert).toBeDefined();
    expect(alert.urgency).toBe('urgent');
  });

  it('does not page anyone urgently because a stranger posted to the public endpoint', async () => {
    const { svc, raised, refusals } = quiet();
    refusals.couldNotAuthenticate('signature does not match the bytes that arrived');
    await svc.checkAndAlert();
    const alert = raised.flatMap((r) => r.list).find((a: any) => a.key === 'didit_deliveries_unauthenticated');
    expect(alert).toBeDefined();
    expect(alert.urgency).not.toBe('urgent');
  });

  it('says a provider would not answer, and says it urgently', async () => {
    const { svc, raised, refusals } = quiet();
    refusals.providerFailed('identity verification could not be started');
    await svc.checkAndAlert();
    const alert = raised.flatMap((r) => r.list).find((a: any) => a.key === 'didit_provider_unreachable');
    expect(alert).toBeDefined();
    expect(alert.urgency).toBe('urgent');
  });

  it('does not call its own configured ceiling a provider failure', async () => {
    const { svc, raised, refusals } = quiet();
    refusals.budgetExhausted('this anchor has already opened 200 verifications in the last day, which is its whole budget');
    await svc.checkAndAlert();
    const keys = keyOf(raised);
    expect(keys).toContain('didit_budget_exhausted');
    expect(keys).not.toContain('didit_provider_unreachable');
  });
});

describe('a new alert reaches the operator only if its family is in scope', () => {
  it('carries the spending ceiling in the scope the monitor raises under', () => {
    expect(MONITORING_ALERT_SCOPE).toContain('didit_budget_exhausted');
    expect(MONITORING_ALERT_SCOPE).toContain('didit_provider_unreachable');
    expect(MONITORING_ALERT_SCOPE).toContain('didit_deliveries_unauthenticated');
  });
});
