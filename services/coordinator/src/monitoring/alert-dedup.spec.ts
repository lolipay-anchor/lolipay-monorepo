import { MonitoringService, MONITORING_ALERT_SCOPE } from './monitoring.service';
import { DiditRefusalsService } from './didit-refusals.service';
import { Alert, AlertsService, summarise, byUrgencyFirst, fitToBudget } from './alerts.service';
import { ALERT_SAMPLE_LIMIT } from './monitoring.conditions';

const SCOPE = MONITORING_ALERT_SCOPE;
const NOW = new Date('2026-08-25T12:00:00Z');

const NO_WEBHOOK = Symbol('unset');

function makeAlerts(
  rows: any[] = [],
  webhook: string | typeof NO_WEBHOOK = 'https://hook.invalid/x',
) {
  const enqueued: any[] = [];
  const state = {
    findMany: jest.fn().mockResolvedValue(rows),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    createMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  const prisma = {
    alertState: state,
    $transaction: jest.fn(async (fn: any) => fn({ alertState: state })),
  } as any;
  const outbox = {
    register: jest.fn(),
    enqueue: jest.fn(async (_tx: any, job: any) => {
      enqueued.push(job);
    }),
  } as any;
  const svc = new AlertsService(
    prisma,
    { alertWebhookUrl: webhook === NO_WEBHOOK ? undefined : webhook } as any,
    outbox,
  );
  return { svc, state, prisma, outbox, enqueued };
}

const routine = (key: string, fingerprint: string): Alert => ({
  key,
  fingerprint,
  urgency: 'routine',
  text: `${key} is unhappy`,
});

const seen = (key: string, fingerprint: string, agoMs: number) => ({
  key,
  fingerprint,
  lastSentAt: new Date(NOW.getTime() - agoMs),
  firstSeenAt: new Date(NOW.getTime() - agoMs),
  sendCount: 1,
});

describe('when an alert speaks', () => {
  it('speaks the first time a condition is seen', async () => {
    const { svc } = makeAlerts([]);
    const { sent } = await svc.raise(SCOPE, [routine('open_dispute:o1', 'o1')], new Set(), NOW);
    expect(sent.map((a: Alert) => a.key)).toEqual(['open_dispute:o1']);
  });

  it('stays silent while the same condition holds unchanged', async () => {
    const { svc } = makeAlerts([seen('open_dispute:o1', 'o1', 60_000)]);
    const { sent } = await svc.raise(SCOPE, [routine('open_dispute:o1', 'o1')], new Set(), NOW);
    expect(sent).toEqual([]);
  });

  it('speaks again when the condition changes', async () => {
    const { svc } = makeAlerts([seen('indexer_stalled', 'never', 60_000)]);
    const { sent } = await svc.raise(SCOPE, [routine('indexer_stalled', 'lagging')], new Set(), NOW);
    expect(sent).toHaveLength(1);
  });

  it('reminds once every six hours so a standing problem is not forgotten', async () => {
    const quiet = makeAlerts([seen('open_dispute:o1', 'o1', 6 * 60 * 60 * 1000 - 1000)]);
    expect(
      (await quiet.svc.raise(SCOPE, [routine('open_dispute:o1', 'o1')], new Set(), NOW)).sent,
    ).toEqual([]);

    const due = makeAlerts([seen('open_dispute:o1', 'o1', 6 * 60 * 60 * 1000)]);
    expect(
      (await due.svc.raise(SCOPE, [routine('open_dispute:o1', 'o1')], new Set(), NOW)).sent,
    ).toHaveLength(1);
  });

  it('reports a condition that has cleared', async () => {
    const { svc } = makeAlerts([seen('open_dispute:o1', 'o1', 1000)]);
    const { sent, cleared } = await svc.raise(SCOPE, [], new Set(), NOW);
    expect(sent).toEqual([]);
    expect(cleared).toEqual(['open_dispute:o1']);
  });

  it('when the state table cannot be read it talks too much rather than falling silent', async () => {
    const { svc, state } = makeAlerts([]);
    state.findMany.mockRejectedValue(new Error('db down'));
    const alerts = [routine('open_dispute:o1', 'o1'), routine('release_overdue:o2', 'o2')];
    const { sent, cleared } = await svc.raise(SCOPE, alerts, new Set(), NOW);
    expect(sent).toEqual(alerts);
    expect(cleared).toEqual([]);
  });
});

describe('an urgent alert keeps its own clock', () => {
  const urgent: Alert = {
    key: 'liability_established:o1',
    fingerprint: 'x',
    urgency: 'urgent',
    text: 'a verdict is waiting on a slash',
  };
  const urgentScope = [...SCOPE, 'liability_established'];

  it('repeats on a fifteen-minute clock, not the six-hour one', async () => {
    const { svc } = makeAlerts([seen('liability_established:o1', 'x', 16 * 60 * 1000)]);
    expect((await svc.raise(urgentScope, [urgent], new Set(), NOW)).sent).toHaveLength(1);

    const routineHarness = makeAlerts([seen('open_dispute:o1', 'o1', 16 * 60 * 1000)]);
    expect(
      (await routineHarness.svc.raise(SCOPE, [routine('open_dispute:o1', 'o1')], new Set(), NOW))
        .sent,
    ).toEqual([]);
  });

  it('does not repeat every single tick either', async () => {
    const { svc } = makeAlerts([seen('liability_established:o1', 'x', 1000)]);
    expect((await svc.raise(urgentScope, [urgent], new Set(), NOW)).sent).toEqual([]);
  });

  it('is sent the moment it first appears', async () => {
    const { svc } = makeAlerts([]);
    expect((await svc.raise(urgentScope, [urgent], new Set(), NOW)).sent).toHaveLength(1);
  });

  it('marks the message urgently so it reads differently in the channel', async () => {
    const { svc, enqueued } = makeAlerts([]);
    await svc.raise(urgentScope, [urgent], new Set(), NOW);
    expect(enqueued[0].payload.text).toContain('🚨');
  });
});

describe('one detector never clears another detector alerts', () => {
  it('ignores keys outside the scope it was given', async () => {
    const { svc } = makeAlerts([
      seen('open_dispute:o1', 'o1', 1000),
      seen('escrow_divergence:o9', 'o9', 1000),
    ]);
    const { cleared } = await svc.raise(SCOPE, [], new Set(), NOW);
    expect(cleared).toEqual(['open_dispute:o1']);
  });

  it('does not raise an alert belonging to another scope', async () => {
    const { svc } = makeAlerts([]);
    const { sent } = await svc.raise(SCOPE, [routine('escrow_divergence:o9', 'o9')], new Set(), NOW);
    expect(sent).toEqual([]);
  });
});

describe('delivery is the queue job, not the tick job', () => {
  it('records the alert and enqueues it in the same transaction', async () => {
    const { svc, prisma, state, enqueued } = makeAlerts([]);
    await svc.raise(SCOPE, [routine('open_dispute:o1', 'o1')], new Set(), NOW);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(state.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          key: 'open_dispute:o1',
          fingerprint: 'o1',
          lastSentAt: NOW,
          sendCount: 1,
        }),
      ],
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].kind).toBe('ops_alert');
  });

  it('carries the send count forward so a reminder is a distinct decision', async () => {
    const prior = seen('open_dispute:o1', 'o1', 6 * 60 * 60 * 1000);
    prior.sendCount = 4;
    const { svc, state } = makeAlerts([prior]);
    await svc.raise(SCOPE, [routine('open_dispute:o1', 'o1')], new Set(), NOW);
    expect(state.createMany.mock.calls[0][0].data[0].sendCount).toBe(5);
  });

  it('keeps the first sighting rather than resetting it on a reminder', async () => {
    const prior = seen('open_dispute:o1', 'o1', 6 * 60 * 60 * 1000);
    const { svc, state } = makeAlerts([prior]);
    await svc.raise(SCOPE, [routine('open_dispute:o1', 'o1')], new Set(), NOW);
    expect(state.createMany.mock.calls[0][0].data[0].firstSeenAt).toEqual(prior.firstSeenAt);
  });

  it('enqueues nothing at all while no webhook is configured', async () => {
    const { svc, enqueued } = makeAlerts([], NO_WEBHOOK);
    await svc.raise(SCOPE, [routine('open_dispute:o1', 'o1')], new Set(), NOW);
    expect(enqueued).toEqual([]);
  });

  it('records nothing either, so configuring a channel does not begin with hours of silence', async () => {
    const { svc, state, prisma } = makeAlerts([], NO_WEBHOOK);
    await svc.raise(SCOPE, [routine('open_dispute:o1', 'o1')], new Set(), NOW);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(state.createMany).not.toHaveBeenCalled();
    expect(state.deleteMany).not.toHaveBeenCalled();
  });

  it('announces everything that is already open on the first tick after a channel appears', async () => {
    const live = [routine('open_dispute:o1', 'o1'), routine('release_overdue:o2', 'o2')];

    const dark = makeAlerts([], NO_WEBHOOK);
    await dark.svc.raise(SCOPE, live, new Set(), NOW);

    const lit = makeAlerts([], 'https://hook.invalid/x');
    const { sent } = await lit.svc.raise(SCOPE, live, new Set(), NOW);
    expect(sent.map((a: Alert) => a.key)).toEqual(['open_dispute:o1', 'release_overdue:o2']);
    expect(lit.enqueued).toHaveLength(1);
  });

  it('registers itself as the handler for its own kind', () => {
    const { svc, outbox } = makeAlerts([]);
    svc.onModuleInit();
    expect(outbox.register).toHaveBeenCalledWith('ops_alert', expect.any(Function));
  });

  it('throws on a non-2xx so the queue retries instead of counting it delivered', async () => {
    const { svc } = makeAlerts([]);
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 500 }) as any;
    await expect(svc.deliver({ text: 'x' })).rejects.toThrow('500');
  });

  it('accepts a 2xx quietly', async () => {
    const { svc } = makeAlerts([]);
    global.fetch = jest.fn().mockResolvedValue({ ok: true, status: 204 }) as any;
    await expect(svc.deliver({ text: 'x' })).resolves.toBeUndefined();
  });

  it('gives the webhook a deadline rather than hanging the queue on it', async () => {
    const { svc } = makeAlerts([]);
    const spy = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = spy as any;
    await svc.deliver({ text: 'x' });
    expect(spy.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('sends only the text, never the metrics blob, to the third party', async () => {
    const { svc } = makeAlerts([]);
    const spy = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    global.fetch = spy as any;
    await svc.deliver({ text: 'hello', at: 'now' });
    expect(JSON.parse(spy.mock.calls[0][1].body)).toEqual({ text: 'hello', content: 'hello' });
  });
});

describe('a new problem is always news, even when the count did not move', () => {
  it('announces a fresh dispute that replaced a resolved one', async () => {
    const { svc } = makeAlerts([
      seen('open_dispute:ord-1', 'ord-1', 1000),
      seen('open_dispute:ord-2', 'ord-2', 1000),
    ]);
    const live = [routine('open_dispute:ord-2', 'ord-2'), routine('open_dispute:ord-3', 'ord-3')];
    const { sent, cleared } = await svc.raise(SCOPE, live, new Set(), NOW);
    expect(sent.map((a: Alert) => a.key)).toEqual(['open_dispute:ord-3']);
    expect(cleared).toEqual(['open_dispute:ord-1']);
  });
});

describe('a truncated list never reports anything as cleared', () => {
  it('holds back every clearance in the family whose list was incomplete', async () => {
    const { svc } = makeAlerts([seen('open_dispute:d0', 'd0', 1000)]);
    const { cleared } = await svc.raise(SCOPE, [], new Set(['open_dispute']), NOW);
    expect(cleared).toEqual([]);
  });

  it('still reports a clearance in a family that was complete', async () => {
    const { svc } = makeAlerts([
      seen('open_dispute:d0', 'd0', 1000),
      seen('release_overdue:r9', 'r9', 1000),
    ]);
    const { cleared } = await svc.raise(SCOPE, [], new Set(['open_dispute']), NOW);
    expect(cleared).toEqual(['release_overdue:r9']);
  });
});

describe('the message an operator actually receives', () => {
  it('bounds the message by characters, so the longest alert cannot burst the limit', () => {
    const longest = (i: number) =>
      `order ${'0'.repeat(36)}-${i} (trade ${'a'.repeat(64)}) has been disputed for 40 days and nobody has resolved it — the escrow entry expires 45 days after its last write, after which the funds need a ledger restore`;
    const many: Alert[] = Array.from({ length: 300 }, (_, i) => ({
      key: `open_dispute:o${i}`,
      fingerprint: `o${i}`,
      urgency: 'urgent',
      text: longest(i),
    }));
    const text = summarise(many);
    expect(text.length).toBeLessThan(2000);
    expect(text).toMatch(/more not listed/);
  });

  it('sends everything when everything fits inside the budget', () => {
    const few: Alert[] = Array.from({ length: 4 }, (_, i) => ({
      key: `k${i}`,
      fingerprint: `k${i}`,
      urgency: 'routine',
      text: `short ${i}`,
    }));
    const text = summarise(few);
    expect(text).not.toMatch(/more not listed/);
    expect(text).toBe('short 0 · short 1 · short 2 · short 3');
  });

  it('never returns an empty message when there is something to say', () => {
    const huge: Alert = {
      key: 'k',
      fingerprint: 'k',
      urgency: 'urgent',
      text: 'x'.repeat(5000),
    };
    const text = summarise([huge]);
    expect(text.length).toBeGreaterThan(0);
    expect(text.length).toBeLessThanOrEqual(1800);
  });

  it('says nothing about omission when everything fits', () => {
    expect(
      summarise([
        { key: 'a', fingerprint: 'a', urgency: 'routine', text: 'one' },
        { key: 'b', fingerprint: 'b', urgency: 'routine', text: 'two' },
      ]),
    ).toBe('one · two');
  });
});

describe('a dispute nobody resolves stops being routine', () => {
  const metrics = {
    generated_at: 'now',
    orders_by_status: {},
    open_disputes: 0,
    release_overdue: 0,
    fiat_payment_overdue: 0,
    indexer_lag_seconds: 5,
  };

  function monitoringWith(disputeAt: Date | null) {
    const prisma = {
      order: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([{ id: 'ord-1', tradeId: 'tr-1', disputeAt, createdAt: new Date() }])
          .mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      config: { findUnique: jest.fn().mockResolvedValue({ payWindowSecs: 1800, confirmWindowSecs: 1800 }) },
      indexerState: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date() }) },
      kycVerification: { count: jest.fn().mockResolvedValue(0) },
    } as any;
    return new MonitoringService(prisma, { raise: jest.fn() } as any, new DiditRefusalsService(), { stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })), prune: jest.fn(async () => 0) } as any, { getTradeStatus: jest.fn(async () => null), getSlashedSoFar: jest.fn(async () => 0n), stakingCooldownSecs: jest.fn(async () => 349_201) } as any, { escrowContractId: 'CESCROW' } as any);
  }

  it('escalates a thirty-day-old dispute to urgent on the same key', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const alerts = await monitoringWith(old).buildAlerts(metrics);
    expect(alerts[0].key).toBe('open_dispute:ord-1');
    expect(alerts[0].urgency).toBe('urgent');
    expect(alerts[0].text).toContain('31 days');
    expect(alerts[0].text).toContain('ledger restore');
  });

  it('leaves a fresh dispute routine', async () => {
    const fresh = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const alerts = await monitoringWith(fresh).buildAlerts(metrics);
    expect(alerts[0].urgency).toBe('routine');
  });

  it('changes the fingerprint when it goes stale, so the escalation is announced', async () => {
    const fresh = await monitoringWith(new Date(Date.now() - 1000)).buildAlerts(metrics);
    const stale = await monitoringWith(
      new Date(Date.now() - 40 * 24 * 60 * 60 * 1000),
    ).buildAlerts(metrics);
    expect(fresh[0].fingerprint).not.toBe(stale[0].fingerprint);
  });
});

describe('a dispute the poller stamped still ages', () => {
  const metrics = {
    generated_at: 'now',
    orders_by_status: {},
    open_disputes: 0,
    release_overdue: 0,
    fiat_payment_overdue: 0,
    indexer_lag_seconds: 5,
  };

  it('falls back to when the order was created when nothing recorded a dispute time', async () => {
    const prisma = {
      order: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([
            {
              id: 'ord-1',
              tradeId: 'tr-1',
              disputeAt: null,
              createdAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000),
            },
          ])
          .mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      config: { findUnique: jest.fn().mockResolvedValue({ payWindowSecs: 1800, confirmWindowSecs: 1800 }) },
      indexerState: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date() }) },
      kycVerification: { count: jest.fn().mockResolvedValue(0) },
    } as any;
    const svc = new MonitoringService(prisma, { raise: jest.fn() } as any, new DiditRefusalsService(), { stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })), prune: jest.fn(async () => 0) } as any, { getTradeStatus: jest.fn(async () => null), getSlashedSoFar: jest.fn(async () => 0n), stakingCooldownSecs: jest.fn(async () => 349_201) } as any, { escrowContractId: 'CESCROW' } as any);

    const alerts = await svc.buildAlerts(metrics);
    expect(alerts[0].urgency).toBe('urgent');
    expect(alerts[0].text).toContain('45 days');
  });
});

describe('the seam between finding conditions and deciding about them', () => {
  const metrics = {
    generated_at: 'now',
    orders_by_status: {},
    open_disputes: 0,
    release_overdue: 0,
    fiat_payment_overdue: 0,
    indexer_lag_seconds: 5,
  };

  function monitoringWith(disputeCount: number, raise = jest.fn()) {
    const prisma = {
      order: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(
            Array.from({ length: disputeCount }, (_, i) => ({
              id: `d${i}`,
              tradeId: `t${i}`,
              disputeAt: new Date(),
              createdAt: new Date(),
            })),
          )
          .mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      config: { findUnique: jest.fn().mockResolvedValue({ payWindowSecs: 1800, confirmWindowSecs: 1800 }) },
      indexerState: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date() }) },
      kycVerification: { count: jest.fn().mockResolvedValue(0) },
    } as any;
    return { svc: new MonitoringService(prisma, { raise } as any, new DiditRefusalsService(), { stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })), prune: jest.fn(async () => 0) } as any, { getTradeStatus: jest.fn(async () => null), getSlashedSoFar: jest.fn(async () => 0n), stakingCooldownSecs: jest.fn(async () => 349_201) } as any, { escrowContractId: 'CESCROW' } as any), prisma, raise };
  }

  it('tells the alerts service which families it could not see the whole of', async () => {
    const { svc, raise } = monitoringWith(ALERT_SAMPLE_LIMIT);
    await svc.checkAndAlert();
    const incomplete = (raise.mock.calls[0] as any[])[2];
    expect(incomplete.has('open_dispute')).toBe(true);
  });

  it('reports every family as complete when none was truncated', async () => {
    const { svc, raise } = monitoringWith(3);
    await svc.checkAndAlert();
    const incomplete = (raise.mock.calls[0] as any[])[2];
    expect(incomplete.size).toBe(0);
  });

  it('raises a truncation notice so the gap is visible, not just guarded', async () => {
    const { svc } = monitoringWith(ALERT_SAMPLE_LIMIT);
    const alerts = await svc.buildAlerts(metrics);
    const over = alerts.find((a: Alert) => a.key === 'open_dispute:overflow');
    expect(over).toBeDefined();
    expect(over!.text).toContain('truncated');
  });

  it('says nothing about truncation when the list fits', async () => {
    const { svc } = monitoringWith(ALERT_SAMPLE_LIMIT - 1);
    const alerts = await svc.buildAlerts(metrics);
    expect(alerts.find((a: Alert) => a.key === 'open_dispute:overflow')).toBeUndefined();
  });

  it('keeps the indexer fingerprint still while it lags, so it does not shout every tick', async () => {
    const { svc } = monitoringWith(0);
    const slow = await svc.buildAlerts({ ...metrics, indexer_lag_seconds: 300 });
    const { svc: svc2 } = monitoringWith(0);
    const slower = await svc2.buildAlerts({ ...metrics, indexer_lag_seconds: 9000 });
    const a = slow.find((x: Alert) => x.key === 'indexer_stalled');
    const b = slower.find((x: Alert) => x.key === 'indexer_stalled');
    expect(a!.fingerprint).toBe(b!.fingerprint);
  });

  it('asks the database for a bounded, deterministically ordered sample', async () => {
    const { svc, prisma } = monitoringWith(0);
    await svc.buildAlerts(metrics);
    const args = prisma.order.findMany.mock.calls[0][0];
    expect(args.take).toBe(ALERT_SAMPLE_LIMIT);
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
  });
});

describe('a message that never arrived is itself a condition', () => {
  const metrics = {
    generated_at: 'now',
    orders_by_status: {},
    open_disputes: 0,
    release_overdue: 0,
    fiat_payment_overdue: 0,
    indexer_lag_seconds: 5,
  };

  function withOutbox(counts: { failed: number; stalled: number }) {
    const prisma = {
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      config: { findUnique: jest.fn().mockResolvedValue({ payWindowSecs: 1800, confirmWindowSecs: 1800 }) },
      indexerState: { findUnique: jest.fn().mockResolvedValue({ updatedAt: new Date() }) },
      kycVerification: { count: jest.fn().mockResolvedValue(0) },
    } as any;
    const outbox = {
      stuckCounts: jest.fn(async () => counts),
      prune: jest.fn(async () => 0),
    } as any;
    return new MonitoringService(prisma, { raise: jest.fn() } as any, new DiditRefusalsService(), outbox, { getTradeStatus: jest.fn(async () => null), getSlashedSoFar: jest.fn(async () => 0n), stakingCooldownSecs: jest.fn(async () => 349_201) } as any, { escrowContractId: 'CESCROW' } as any);
  }

  it('says so when something it tried to tell you gave up', async () => {
    const alerts = await withOutbox({ failed: 2, stalled: 0 }).buildAlerts(metrics);
    const a = alerts.find((x: Alert) => x.key === 'delivery_failing');
    expect(a).toBeDefined();
    expect(a!.text).toContain('did not arrive');
  });

  it('also notices messages that are merely stuck, not yet given up', async () => {
    const alerts = await withOutbox({ failed: 0, stalled: 4 }).buildAlerts(metrics);
    expect(alerts.some((x: Alert) => x.key === 'delivery_failing')).toBe(true);
  });

  it('stays quiet when the queue is healthy', async () => {
    const alerts = await withOutbox({ failed: 0, stalled: 0 }).buildAlerts(metrics);
    expect(alerts.some((x: Alert) => x.key === 'delivery_failing')).toBe(false);
  });

  it('is inside the scope monitoring claims, so it can be cleared', () => {
    expect(MONITORING_ALERT_SCOPE).toContain('delivery_failing');
  });
});

describe('an urgent alert must not be budgeted out of its own message', () => {
  const NOW2 = new Date('2026-08-26T12:00:00Z');

  const long = (i: number): Alert => ({
    key: `open_dispute:o${i}`,
    fingerprint: `o${i}`,
    urgency: 'routine',
    text: `order ${'0'.repeat(36)}-${i} (trade ${'a'.repeat(64)}) is disputed and awaiting resolution`,
  });

  const urgentAlert: Alert = {
    key: 'slash_window_open:victim',
    fingerprint: 'under-1h',
    urgency: 'urgent',
    text: 'order victim has a verdict against the provider and 42 minute(s) left to recover',
  };

  it('puts the urgent one in the message even when routine noise would have filled it', () => {
    const text = summarise([...Array.from({ length: 100 }, (_, i) => long(i)), urgentAlert]);
    expect(text).toContain('42 minute(s) left');
  });

  it('keeps urgent alerts ahead of routine ones', () => {
    const ordered = byUrgencyFirst([long(1), urgentAlert, long(2)]);
    expect(ordered[0].key).toBe('slash_window_open:victim');
  });

  it('reports what did not fit rather than dropping it silently', () => {
    const { included, omitted } = fitToBudget([
      ...Array.from({ length: 100 }, (_, i) => long(i)),
      urgentAlert,
    ]);
    expect(omitted).toBeGreaterThan(0);
    expect(included.map((a) => a.key)).toContain('slash_window_open:victim');
  });

  it('does not record an alert whose text never made it into a message', async () => {
    const { svc, state } = makeAlerts([]);
    const many = [...Array.from({ length: 100 }, (_, i) => long(i)), urgentAlert];
    const { sent } = await svc.raise(
      [...SCOPE, 'slash_window_open'],
      many,
      new Set(),
      NOW2,
    );
    const recorded = state.createMany.mock.calls[0][0].data.map((d: any) => d.key);
    expect(recorded.length).toBe(sent.length);
    expect(recorded.length).toBeLessThan(many.length);
    expect(recorded).toContain('slash_window_open:victim');
  });
});
