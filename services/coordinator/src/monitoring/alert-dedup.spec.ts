import { MonitoringService, Alert, summarise } from './monitoring.service';
import { ALERT_SAMPLE_LIMIT } from './monitoring.conditions';

const NO_WEBHOOK = Symbol('unset');

function makeSvc(rows: any[] = [], webhook: string | typeof NO_WEBHOOK = 'https://hook.invalid/x') {
  const state = {
    findMany: jest.fn().mockResolvedValue(rows),
    upsert: jest.fn(),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const prisma = {
    alertState: state,
    $transaction: jest.fn().mockResolvedValue([]),
    order: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    indexerState: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date() }) },
  } as any;
  const cfg = { alertWebhookUrl: webhook === NO_WEBHOOK ? undefined : webhook } as any;
  return { svc: new MonitoringService(prisma, cfg) as any, state, prisma };
}

const routine = (key: string, fingerprint: string): Alert => ({
  key,
  fingerprint,
  urgency: 'routine',
  text: `${key} is unhappy`,
});

describe('alert dedup', () => {
  const NOW = new Date('2026-08-25T12:00:00Z');

  it('sends a condition the first time it is seen', async () => {
    const { svc } = makeSvc([]);
    const { toSend } = await svc.reconcileAlerts([routine('open_disputes', '2')], NOW);
    expect(toSend.map((a: Alert) => a.key)).toEqual(['open_disputes']);
  });

  it('stays silent while the same condition holds unchanged', async () => {
    const { svc } = makeSvc([
      { key: 'open_disputes', fingerprint: '2', lastSentAt: new Date(NOW.getTime() - 60_000) },
    ]);
    const { toSend } = await svc.reconcileAlerts([routine('open_disputes', '2')], NOW);
    expect(toSend).toEqual([]);
  });

  it('speaks again when the condition changes, because a third dispute is news', async () => {
    const { svc } = makeSvc([
      { key: 'open_disputes', fingerprint: '2', lastSentAt: new Date(NOW.getTime() - 60_000) },
    ]);
    const { toSend } = await svc.reconcileAlerts([routine('open_disputes', '3')], NOW);
    expect(toSend.map((a: Alert) => a.key)).toEqual(['open_disputes']);
  });

  it('reminds once every six hours so a standing problem is not forgotten', async () => {
    const justUnder = new Date(NOW.getTime() - (6 * 60 * 60 * 1000 - 1000));
    const justOver = new Date(NOW.getTime() - 6 * 60 * 60 * 1000);

    const quiet = makeSvc([{ key: 'open_disputes', fingerprint: '2', lastSentAt: justUnder }]);
    expect((await quiet.svc.reconcileAlerts([routine('open_disputes', '2')], NOW)).toSend).toEqual([]);

    const due = makeSvc([{ key: 'open_disputes', fingerprint: '2', lastSentAt: justOver }]);
    expect(
      (await due.svc.reconcileAlerts([routine('open_disputes', '2')], NOW)).toSend,
    ).toHaveLength(1);
  });

  const urgent: Alert = {
    key: 'liability_established',
    fingerprint: 'x',
    urgency: 'urgent',
    text: 'a verdict is waiting on a slash',
  };

  it('repeats an urgent alert on its own short clock, not the six-hour one', async () => {
    const sixteenMinutes = new Date(NOW.getTime() - 16 * 60 * 1000);
    const { svc } = makeSvc([
      { key: 'liability_established', fingerprint: 'x', lastSentAt: sixteenMinutes },
    ]);
    const { toSend } = await svc.reconcileAlerts([urgent], NOW);
    expect(toSend).toHaveLength(1);

    const routine = makeSvc([
      { key: 'open_dispute:o1', fingerprint: 'o1', lastSentAt: sixteenMinutes },
    ]);
    const quiet = await routine.svc.reconcileAlerts(
      [{ key: 'open_dispute:o1', fingerprint: 'o1', urgency: 'routine', text: 'x' }],
      NOW,
    );
    expect(quiet.toSend).toEqual([]);
  });

  it('does not repeat an urgent alert every single tick either', async () => {
    const { svc } = makeSvc([
      { key: 'liability_established', fingerprint: 'x', lastSentAt: new Date(NOW.getTime() - 1000) },
    ]);
    const { toSend } = await svc.reconcileAlerts([urgent], NOW);
    expect(toSend).toEqual([]);
  });

  it('sends an urgent alert the moment it first appears', async () => {
    const { svc } = makeSvc([]);
    const { toSend } = await svc.reconcileAlerts([urgent], NOW);
    expect(toSend).toHaveLength(1);
  });

  it('reports a condition that has cleared, and only once', async () => {
    const { svc } = makeSvc([
      { key: 'open_disputes', fingerprint: '2', lastSentAt: new Date(NOW.getTime() - 1000) },
    ]);
    const { toSend, resolved } = await svc.reconcileAlerts([], NOW);
    expect(toSend).toEqual([]);
    expect(resolved).toEqual(['open_disputes']);
  });

  it('when the state table cannot be read it talks too much rather than falling silent', async () => {
    const { svc, state } = makeSvc([]);
    state.findMany.mockRejectedValue(new Error('db down'));
    const alerts = [routine('open_disputes', '2'), routine('release_overdue', '1')];
    const { toSend, resolved } = await svc.reconcileAlerts(alerts, NOW);
    expect(toSend).toEqual(alerts);
    expect(resolved).toEqual([]);
  });
});

describe('alert delivery decides what is remembered', () => {
  function fetchReturning(ok: boolean) {
    return jest.fn().mockResolvedValue({ ok, status: ok ? 200 : 500 });
  }

  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  function svcWithMetrics(rows: any[], webhook?: string | typeof NO_WEBHOOK) {
    const h = webhook === undefined ? makeSvc(rows) : makeSvc(rows, webhook);
    h.prisma.order.findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'ord-1', tradeId: 'tr-1' }])
      .mockResolvedValue([]);
    h.svc.metrics = jest.fn().mockResolvedValue({
      generated_at: 'now',
      orders_by_status: {},
      open_disputes: 2,
      release_overdue: 0,
      fiat_payment_overdue: 0,
      indexer_lag_seconds: 5,
    });
    return h;
  }

  it('records the alert once the webhook accepted it', async () => {
    const { svc, prisma } = svcWithMetrics([]);
    global.fetch = fetchReturning(true) as any;
    await svc.checkAndAlert();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('remembers nothing when the webhook refused, so the next tick tries again', async () => {
    const { svc, prisma } = svcWithMetrics([]);
    global.fetch = fetchReturning(false) as any;
    await svc.checkAndAlert();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('remembers nothing when the webhook threw', async () => {
    const { svc, prisma } = svcWithMetrics([]);
    global.fetch = jest.fn().mockRejectedValue(new Error('socket hang up')) as any;
    await svc.checkAndAlert();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('records nothing while no webhook is configured, so setting one later announces everything open', async () => {
    const { svc, prisma } = svcWithMetrics([], NO_WEBHOOK);
    global.fetch = fetchReturning(true) as any;
    await svc.checkAndAlert();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('gives the webhook a deadline rather than hanging the cron on it', async () => {
    const { svc } = svcWithMetrics([]);
    const spy = fetchReturning(true);
    global.fetch = spy as any;
    await svc.checkAndAlert();
    expect(spy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('forgets a cleared condition only after the all-clear was delivered', async () => {
    const rows = [{ key: 'open_dispute:ord-1', fingerprint: 'ord-1', lastSentAt: new Date() }];
    const ok = makeSvc(rows);
    ok.svc.metrics = jest.fn().mockResolvedValue({
      generated_at: 'now',
      orders_by_status: {},
      open_disputes: 0,
      release_overdue: 0,
      fiat_payment_overdue: 0,
      indexer_lag_seconds: 5,
    });
    global.fetch = fetchReturning(true) as any;
    await ok.svc.checkAndAlert();
    expect(ok.state.deleteMany).toHaveBeenCalledWith({
      where: { key: { in: ['open_dispute:ord-1'] } },
    });

    const bad = makeSvc(rows);
    bad.svc.metrics = ok.svc.metrics;
    global.fetch = fetchReturning(false) as any;
    await bad.svc.checkAndAlert();
    expect(bad.state.deleteMany).not.toHaveBeenCalled();
  });
});

describe('a new problem is always news, even when the count did not move', () => {
  const NOW = new Date('2026-08-25T12:00:00Z');

  it('announces a fresh dispute that replaced a resolved one', async () => {
    const known = [
      { key: 'open_dispute:ord-1', fingerprint: 'ord-1', lastSentAt: new Date(NOW.getTime() - 1000) },
      { key: 'open_dispute:ord-2', fingerprint: 'ord-2', lastSentAt: new Date(NOW.getTime() - 1000) },
    ];
    const { svc } = makeSvc(known);

    const live: Alert[] = [
      { key: 'open_dispute:ord-2', fingerprint: 'ord-2', urgency: 'routine', text: 'ord-2 disputed' },
      { key: 'open_dispute:ord-3', fingerprint: 'ord-3', urgency: 'routine', text: 'ord-3 disputed' },
    ];

    const { toSend, resolved } = await svc.reconcileAlerts(live, NOW);
    expect(toSend.map((a: Alert) => a.key)).toEqual(['open_dispute:ord-3']);
    expect(resolved).toEqual(['open_dispute:ord-1']);
  });

  it('keeps quiet about the one that has not changed', async () => {
    const known = [
      { key: 'open_dispute:ord-2', fingerprint: 'ord-2', lastSentAt: new Date(NOW.getTime() - 1000) },
    ];
    const { svc } = makeSvc(known);
    const live: Alert[] = [
      { key: 'open_dispute:ord-2', fingerprint: 'ord-2', urgency: 'routine', text: 'ord-2 disputed' },
    ];
    const { toSend } = await svc.reconcileAlerts(live, NOW);
    expect(toSend).toEqual([]);
  });

  it('names the order in the message, so the operator does not have to go looking', async () => {
    const { svc, prisma } = makeSvc([]);
    prisma.order.findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'ord-7', tradeId: 'trade-7' }])
      .mockResolvedValue([]);
    const alerts = await svc.buildAlerts({
      generated_at: 'now',
      orders_by_status: {},
      open_disputes: 1,
      release_overdue: 0,
      fiat_payment_overdue: 0,
      indexer_lag_seconds: 5,
    });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe('open_dispute:ord-7');
    expect(alerts[0].text).toContain('ord-7');
    expect(alerts[0].text).toContain('trade-7');
  });
});

describe('more problems than the sample can carry', () => {
  const NOW = new Date('2026-08-25T12:00:00Z');

  function svcWithDisputes(n: number) {
    const { svc, prisma } = makeSvc([]);
    prisma.order.findMany = jest
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: n }, (_, i) => ({ id: `ord-${i}`, tradeId: `tr-${i}` })),
      )
      .mockResolvedValue([]);
    return svc;
  }

  const metrics = {
    generated_at: 'now',
    orders_by_status: {},
    open_disputes: 0,
    release_overdue: 0,
    fiat_payment_overdue: 0,
    indexer_lag_seconds: 5,
  };

  it('says so when the list is truncated, rather than hiding the rest', async () => {
    const alerts = await svcWithDisputes(ALERT_SAMPLE_LIMIT).buildAlerts(metrics);
    const over = alerts.find((a: Alert) => a.key === 'open_dispute:overflow');
    expect(over).toBeDefined();
    expect(over.text).toContain(String(ALERT_SAMPLE_LIMIT));
    expect(over.text).toContain('truncated');
  });

  it('says nothing about truncation when the list fits', async () => {
    const alerts = await svcWithDisputes(ALERT_SAMPLE_LIMIT - 1).buildAlerts(metrics);
    expect(alerts.find((a: Alert) => a.key === 'open_dispute:overflow')).toBeUndefined();
    expect(alerts).toHaveLength(ALERT_SAMPLE_LIMIT - 1);
  });

  it('does not repeat the truncation notice every tick', async () => {
    const svc = svcWithDisputes(ALERT_SAMPLE_LIMIT);
    const alerts = await svc.buildAlerts(metrics);
    const known = alerts.map((a: Alert) => ({
      key: a.key,
      fingerprint: a.fingerprint,
      lastSentAt: new Date(NOW.getTime() - 1000),
    }));
    const { svc: quiet } = makeSvc(known);
    const { toSend } = await quiet.reconcileAlerts(alerts, NOW);
    expect(toSend).toEqual([]);
  });
});

describe('a truncated list never reports anything as cleared', () => {
  const NOW = new Date('2026-08-25T12:00:00Z');

  const metrics = {
    generated_at: 'now',
    orders_by_status: {},
    open_disputes: 0,
    release_overdue: 0,
    fiat_payment_overdue: 0,
    indexer_lag_seconds: 5,
  };

  it('an order disputed today can be older than the ones already alerted, and must not be read as their disappearance', async () => {
    const known = Array.from({ length: ALERT_SAMPLE_LIMIT }, (_, i) => ({
      key: `open_dispute:d${i}`,
      fingerprint: `d${i}`,
      lastSentAt: new Date(NOW.getTime() - 1000),
    }));
    const { svc, prisma } = makeSvc(known);

    const sampled = [
      { id: 'ANCIENT', tradeId: 'tr-ancient' },
      ...Array.from({ length: ALERT_SAMPLE_LIMIT - 1 }, (_, i) => ({
        id: `d${i}`,
        tradeId: `tr${i}`,
      })),
    ];
    prisma.order.findMany = jest.fn().mockResolvedValueOnce(sampled).mockResolvedValue([]);

    const alerts = await svc.buildAlerts(metrics);
    const { resolved, toSend } = await svc.reconcileAlerts(alerts, NOW);

    const last = `open_dispute:d${ALERT_SAMPLE_LIMIT - 1}`;
    expect(resolved).not.toContain(last);
    expect(resolved).toEqual([]);
    expect(toSend.map((x: Alert) => x.key)).toContain('open_dispute:ANCIENT');
  });

  it('still reports a clearance when the list was not truncated', async () => {
    const known = [
      { key: 'open_dispute:gone', fingerprint: 'gone', lastSentAt: new Date(NOW.getTime() - 1000) },
    ];
    const { svc, prisma } = makeSvc(known);
    prisma.order.findMany = jest.fn().mockResolvedValue([]);
    const alerts = await svc.buildAlerts(metrics);
    const { resolved } = await svc.reconcileAlerts(alerts, NOW);
    expect(resolved).toEqual(['open_dispute:gone']);
  });

  it('a truncation in one family does not silence clearances in another', async () => {
    const known = [
      { key: 'open_dispute:d0', fingerprint: 'd0', lastSentAt: new Date(NOW.getTime() - 1000) },
      { key: 'release_overdue:r9', fingerprint: 'r9', lastSentAt: new Date(NOW.getTime() - 1000) },
    ];
    const { svc, prisma } = makeSvc(known);
    prisma.order.findMany = jest
      .fn()
      .mockResolvedValueOnce(
        Array.from({ length: ALERT_SAMPLE_LIMIT }, (_, i) => ({ id: `x${i}`, tradeId: `tx${i}` })),
      )
      .mockResolvedValue([]);
    const alerts = await svc.buildAlerts(metrics);
    const { resolved } = await svc.reconcileAlerts(alerts, NOW);
    expect(resolved).toEqual(['release_overdue:r9']);
  });
});

describe('the parts a passing suite could still get wrong', () => {
  const NOW = new Date('2026-08-25T12:00:00Z');
  const metrics = {
    generated_at: 'now',
    orders_by_status: {},
    open_disputes: 0,
    release_overdue: 0,
    fiat_payment_overdue: 0,
    indexer_lag_seconds: 5,
  };

  it('remembers a sent alert under its key, not under anything else', async () => {
    const { svc, prisma, state } = makeSvc([]);
    prisma.order.findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'ord-9', tradeId: 'tr-9' }])
      .mockResolvedValue([]);
    svc.metrics = jest.fn().mockResolvedValue(metrics);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as any;

    await svc.checkAndAlert();

    expect(state.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { key: 'open_dispute:ord-9' },
        create: expect.objectContaining({ key: 'open_dispute:ord-9', fingerprint: 'ord-9' }),
        update: expect.objectContaining({ fingerprint: 'ord-9' }),
      }),
    );
  });

  it('keeps the indexer fingerprint still while it lags, so it does not shout every tick', async () => {
    const { svc, prisma } = makeSvc([]);
    prisma.order.findMany = jest.fn().mockResolvedValue([]);

    const first = await svc.buildAlerts({ ...metrics, indexer_lag_seconds: 300 });
    const later = await svc.buildAlerts({ ...metrics, indexer_lag_seconds: 9000 });

    const f = first.find((a: Alert) => a.key === 'indexer_stalled');
    const l = later.find((a: Alert) => a.key === 'indexer_stalled');
    expect(f).toBeDefined();
    expect(l).toBeDefined();
    expect(f.fingerprint).toBe(l.fingerprint);
  });

  it('asks the database for a bounded, deterministically ordered sample', async () => {
    const { svc, prisma } = makeSvc([]);
    prisma.order.findMany = jest.fn().mockResolvedValue([]);
    await svc.buildAlerts(metrics);

    const args = prisma.order.findMany.mock.calls[0][0];
    expect(args.take).toBe(ALERT_SAMPLE_LIMIT);
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(args.select).toEqual({ id: true, tradeId: true });
  });

  it('does not put an unbounded wall of text into one webhook message', async () => {
    const many: Alert[] = Array.from({ length: 300 }, (_, i) => ({
      key: `open_dispute:o${i}`,
      fingerprint: `o${i}`,
      urgency: 'routine',
      text: `order o${i} (trade ${'a'.repeat(64)}) is disputed and awaiting resolution`,
    }));
    const text = summarise(many);
    expect(text.length).toBeLessThan(9000);
    expect(text).toContain('250 more not listed');
  });

  it('says nothing about omission when everything fits', async () => {
    const few: Alert[] = [
      { key: 'a', fingerprint: 'a', urgency: 'routine', text: 'one' },
      { key: 'b', fingerprint: 'b', urgency: 'routine', text: 'two' },
    ];
    expect(summarise(few)).toBe('one · two');
  });

  it('a failing conditions query aborts the tick rather than clearing everything', async () => {
    const { svc, prisma, state } = makeSvc([
      { key: 'open_dispute:o1', fingerprint: 'o1', lastSentAt: new Date(NOW.getTime() - 1000) },
    ]);
    prisma.order.findMany = jest.fn().mockRejectedValue(new Error('db down'));
    svc.metrics = jest.fn().mockResolvedValue(metrics);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 200 }) as any;

    await svc.checkAndAlert();

    expect(global.fetch).not.toHaveBeenCalled();
    expect(state.deleteMany).not.toHaveBeenCalled();
  });
});
