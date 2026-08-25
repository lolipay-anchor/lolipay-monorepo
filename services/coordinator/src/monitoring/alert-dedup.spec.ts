import { MonitoringService, Alert } from './monitoring.service';

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

  it('never suppresses an urgent alert, whatever the state says', async () => {
    const { svc } = makeSvc([
      { key: 'liability_established', fingerprint: 'x', lastSentAt: new Date(NOW.getTime() - 1000) },
    ]);
    const urgent: Alert = {
      key: 'liability_established',
      fingerprint: 'x',
      urgency: 'urgent',
      text: 'a verdict is waiting on a slash',
    };
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
