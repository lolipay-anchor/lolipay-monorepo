import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MonitoringService, MONITORING_ALERT_SCOPE } from './monitoring.service';
import { AlertsService } from './alerts.service';
import { DiditRefusalsService } from './didit-refusals.service';
import { AttestorService } from '../stellar/attestor.service';
import { auditPayload } from '../admin/admin-audit';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxService } from '../outbox/outbox.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { AppConfigService } from '../config/app-config.service';
import {
  ALERT_SAMPLE_LIMIT,
  ATTESTATION_FAILURE_WINDOW_MS,
  ATTESTOR_LOW_BALANCE_STROOPS,
  formatXlm,
  windowWords,
} from './monitoring.conditions';
import * as conditions from './monitoring.conditions';

const T0 = new Date('2026-09-30T12:00:00.000Z');
const MINUTE = 60_000;
const XLM = 10_000_000n;
const ORDER_ID = '4f1d2a3c-1111-4222-8333-444455556666';
const TRADE_ID = 'ab'.repeat(32);

type AuditRow = {
  id: string;
  action: string;
  targetId: string | null;
  createdAt: Date;
  before: unknown;
  after: unknown;
};

function row(id: string, minutesAgo: number, submission: unknown, over: Partial<AuditRow> = {}): AuditRow {
  return {
    id,
    action: 'order.attestFiatPaid',
    targetId: ORDER_ID,
    createdAt: new Date(T0.getTime() - minutesAgo * MINUTE),
    before: auditPayload({ status: 'FUNDED', contractId: 'CESCROW', tradeId: TRADE_ID }),
    after: auditPayload({ evidence: 'BCA 12345', submission, txHash: 'ff'.repeat(32) }),
    ...over,
  };
}

const notSubmitted = (id: string, minutesAgo: number): AuditRow =>
  row(id, minutesAgo, 'NOT_SUBMITTED', {
    after: auditPayload({ evidence: 'BCA 12345', submission: 'NOT_SUBMITTED', error: 'the rpc was down' }),
  });
const chainRefused = (id: string, minutesAgo: number): AuditRow => row(id, minutesAgo, 'FAILED');
const succeeded = (id: string, minutesAgo: number): AuditRow => row(id, minutesAgo, 'SUCCESS');

const isoAgo = (minutes: number) => new Date(T0.getTime() - minutes * MINUTE).toISOString();

const knownRefusals = () => {
  const r = new DiditRefusalsService();
  r.workflowPerformsAml(false);
  return r;
};

function harness(
  opts: { rows?: AuditRow[]; balance?: bigint | null | Error; attestor?: 'absent'; realAttestor?: AttestorService } = {},
) {
  const rows = opts.rows ?? [];
  let balance: bigint | null | Error = opts.balance === undefined ? 1_000n * XLM : opts.balance;
  const stored = new Map<string, any>();
  const alertState = {
    findMany: jest.fn(async () => [...stored.values()]),
    findUnique: jest.fn(async ({ where }: any) => stored.get(where.key) ?? null),
    deleteMany: jest.fn(async ({ where }: any) => {
      let count = 0;
      for (const key of where.key.in as string[]) if (stored.delete(key)) count += 1;
      return { count };
    }),
    createMany: jest.fn(async ({ data }: any) => {
      for (const r of data) stored.set(r.key, { ...r });
      return { count: data.length };
    }),
  };
  const auditFindMany = jest.fn(async (args: any) =>
    rows
      .filter(
        (r) => r.action === args.where.action && r.createdAt.getTime() >= args.where.createdAt.gte.getTime(),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .slice(0, args.take),
  );
  const prisma = {
    order: {
      groupBy: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      findMany: jest.fn(async () => []),
    },
    config: { findUnique: jest.fn(async () => null) },
    indexerState: { findUnique: jest.fn(async () => ({ updatedAt: new Date(Date.now() - 1000) })) },
    kycVerification: { count: jest.fn(async () => 0) },
    lp: { count: jest.fn(async () => 1) },
    adminAudit: { findMany: auditFindMany },
    alertState,
    $transaction: jest.fn(async (fn: any) => fn({ alertState })),
  } as any;
  const enqueued: any[] = [];
  const outbox = {
    register: jest.fn(),
    enqueue: jest.fn(async (_tx: any, job: any) => {
      enqueued.push(job);
    }),
    stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })),
    prune: jest.fn(async () => 0),
  } as any;
  const alerts = new AlertsService(prisma, { alertWebhookUrl: 'https://hook.invalid/x' } as any, outbox);
  const attestor =
    opts.attestor === 'absent'
      ? undefined
      : opts.realAttestor ?? {
          nativeBalanceStroops: jest.fn(async () => {
            if (balance instanceof Error) throw balance;
            return balance;
          }),
        };
  const svc = new MonitoringService(
    prisma,
    alerts,
    knownRefusals(),
    outbox,
    {
      getTradeStatus: jest.fn(async () => null),
      getSlashedSoFar: jest.fn(async () => 0n),
      stakingCooldownSecs: jest.fn(async () => 349_201),
    } as any,
    { escrowContractId: 'CESCROW' } as any,
    attestor as any,
  );
  return {
    svc,
    rows,
    stored,
    enqueued,
    auditFindMany,
    attestor,
    setBalance: (next: bigint | null | Error) => {
      balance = next;
    },
    tick: async (now: Date) => {
      jest.setSystemTime(now);
      const incomplete = new Set<string>();
      const built = await svc.buildAlerts(await svc.metrics(), incomplete);
      const { sent, cleared } = await alerts.raise(MONITORING_ALERT_SCOPE, built, incomplete, now);
      return { built, incomplete, sent, cleared };
    },
  };
}

beforeEach(() => {
  jest.useFakeTimers({ now: T0 });
});

afterEach(() => {
  jest.useRealTimers();
});

describe('an attestation attempt that was not recorded as a success pages the operator', () => {
  it('pages once, through the real alerts service and the real scope, for an attempt recorded as NOT_SUBMITTED, naming the order, the trade, the time and the outcome', async () => {
    const h = harness({ rows: [notSubmitted('a1', 10)] });

    const { sent } = await h.tick(T0);

    expect(sent.map((a) => a.key)).toEqual(['attestation_failed:a1']);
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0].payload.text).toBe(
      `🚨 lolipay coordinator: order ${ORDER_ID} (trade ${TRADE_ID}) had an attestation attempt at ${isoAgo(10)} that was not recorded as a success (NOT_SUBMITTED) — check its on-chain status before trying again`,
    );
    expect(sent[0]).toMatchObject({ urgency: 'urgent', fingerprint: 'NOT_SUBMITTED' });
  });

  it('pages for an attempt the chain refused, naming that outcome', async () => {
    const h = harness({ rows: [chainRefused('a1', 3)] });

    const { sent } = await h.tick(T0);

    expect(sent.map((a) => a.key)).toEqual(['attestation_failed:a1']);
    expect(sent[0].text).toContain('was not recorded as a success (FAILED)');
  });

  it.each<[string, unknown]>([
    ['a row with no submission field', { evidence: 'x' }],
    ['a row with no after at all', null],
    ['a row whose after is not an object', 'garbage'],
    ['a row whose after is an array', ['SUCCESS']],
    ['a lowercase success', { submission: 'success' }],
    ['a numeric submission', { submission: 1 }],
    ['a success with a trailing space', { submission: 'SUCCESS ' }],
  ])('pages for %s, because only an exact SUCCESS is exempt and everything else counts', async (_name, after) => {
    const h = harness({ rows: [row('a1', 5, 'ignored', { after })] });

    const { sent } = await h.tick(T0);

    expect(sent.map((a) => a.key)).toEqual(['attestation_failed:a1']);
    expect(sent[0].text).toContain('was not recorded as a success (unrecognised)');
  });

  it('stays silent for an attempt that succeeded, including one whose evidence is the signed receipt object a provider sends', async () => {
    const receipt = row('a1', 5, 'SUCCESS', {
      after: auditPayload({
        evidence: { message: 'lolipay:confirm-receipt:v1 ...', signature: 'aa', receivedAt: isoAgo(5) },
        submission: 'SUCCESS',
        txHash: 'ee'.repeat(32),
      }),
    });
    const h = harness({ rows: [succeeded('s1', 5), receipt] });

    const { built, sent } = await h.tick(T0);

    expect(built).toEqual([]);
    expect(sent).toEqual([]);
    expect(h.enqueued).toEqual([]);
  });

  it('reads only attestation rows, so another audited action carrying the same word pages nobody', async () => {
    const h = harness({ rows: [row('x1', 5, 'NOT_SUBMITTED', { action: 'lp.setStatus' })] });

    const { built } = await h.tick(T0);

    expect(built).toEqual([]);
    expect((h.auditFindMany.mock.calls[0] as any[])[0].where.action).toBe('order.attestFiatPaid');
  });

  it('stops paging an attempt once it is older than the window, and still pages one just inside it', async () => {
    const windowMinutes = ATTESTATION_FAILURE_WINDOW_MS / MINUTE;
    const h = harness({
      rows: [notSubmitted('inside', windowMinutes - 1), notSubmitted('outside', windowMinutes + 1)],
    });

    const { sent } = await h.tick(T0);

    expect(sent.map((a) => a.key)).toEqual(['attestation_failed:inside']);
  });

  it('gives each failed attempt its own alert, so two presses on one order are two facts', async () => {
    const h = harness({ rows: [notSubmitted('a1', 20), chainRefused('a2', 5)] });

    const { sent } = await h.tick(T0);

    expect(sent.map((a) => a.key).sort()).toEqual(['attestation_failed:a1', 'attestation_failed:a2']);
    expect(sent.find((a) => a.key === 'attestation_failed:a1')!.text).toContain(isoAgo(20));
    expect(sent.find((a) => a.key === 'attestation_failed:a2')!.text).toContain(isoAgo(5));
  });

  it('says nothing new on the next tick, reminds on the urgent cadence while the attempt is inside the window, and reports the clear once it has aged out', async () => {
    const h = harness({ rows: [notSubmitted('a1', 10)] });

    expect((await h.tick(T0)).sent).toHaveLength(1);
    expect((await h.tick(new Date(T0.getTime() + 5 * MINUTE))).sent).toEqual([]);
    expect((await h.tick(new Date(T0.getTime() + 15 * MINUTE))).sent).toHaveLength(1);
    expect(h.enqueued).toHaveLength(2);

    const aged = await h.tick(new Date(T0.getTime() + 70 * MINUTE));
    expect(aged.built).toEqual([]);
    expect(aged.cleared).toEqual(['attestation_failed:a1']);
  });

  it('marks the family incomplete and says so when the window is full, so a truncated list is never reported as cleared', async () => {
    const full = Array.from({ length: ALERT_SAMPLE_LIMIT }, (_, i) => notSubmitted(`a${String(i).padStart(4, '0')}`, 10));
    const h = harness({ rows: full });
    h.stored.set('attestation_failed:long-gone', {
      key: 'attestation_failed:long-gone',
      fingerprint: 'NOT_SUBMITTED',
      lastSentAt: new Date(T0.getTime() - 120 * MINUTE),
      firstSeenAt: new Date(T0.getTime() - 120 * MINUTE),
      sendCount: 1,
    });

    const { built, incomplete, cleared } = await h.tick(T0);

    const notice = built.find((a) => a.key === 'attestation_failed:overflow');
    expect(notice!.text).toBe(
      `at least ${ALERT_SAMPLE_LIMIT} attestation attempts in the last hour — the list is truncated and nothing in this family will be reported as cleared until it is not`,
    );
    expect(incomplete.has('attestation_failed')).toBe(true);
    expect(cleared).not.toContain('attestation_failed:long-gone');

    const calm = harness({ rows: [] });
    calm.stored.set('attestation_failed:long-gone', h.stored.get('attestation_failed:long-gone'));
    expect((await calm.tick(T0)).cleared).toContain('attestation_failed:long-gone');
  });

  it('says it is blind, rather than staying silent, when the audit rows cannot be read', async () => {
    const h = harness({ rows: [notSubmitted('a1', 10)] });
    h.auditFindMany.mockRejectedValue(new Error('the audit table is unreachable'));

    const { built, incomplete, sent } = await h.tick(T0);

    expect(incomplete.has('attestation_failed')).toBe(true);
    expect(built.map((a) => a.key)).toEqual(['monitoring_blind']);
    expect(built[0].fingerprint).toBe('attestation_failed');
    expect(sent.map((a) => a.key)).toEqual(['monitoring_blind']);
  });

  it('never repeats a value it did not write itself into a message an operator reads, however hostile the row is', async () => {
    const hostile = row('a1', 5, 'ignored', {
      targetId: '@everyone http://evil.example\nsecond line',
      before: { tradeId: '`; drop table' },
      after: { submission: '@here <b>bold</b>' },
    });
    const h = harness({ rows: [hostile] });

    const { sent } = await h.tick(T0);

    expect(sent[0].text).toBe(
      `order unknown (trade unknown) had an attestation attempt at ${isoAgo(5)} that was not recorded as a success (unrecognised) — check its on-chain status before trying again`,
    );
  });
});

describe('an attestor account that is running low pages the operator', () => {
  it('pages, as a routine alert, when the balance is below 25 XLM, naming the balance to the stroop', async () => {
    const h = harness({ balance: 24n * XLM + 5_000_000n });

    const { sent } = await h.tick(T0);

    expect(sent.map((a) => a.key)).toEqual(['attestor_balance_low']);
    expect(sent[0]).toMatchObject({ urgency: 'routine', fingerprint: 'low' });
    expect(h.enqueued[0].payload.text).toBe(
      '⚠️ lolipay coordinator: the attestor account holds 24.5000000 XLM, below the 25 XLM this anchor treats as low — every confirmation a provider or the operator makes is sent from this account and its fee is paid from this balance, so once it cannot pay, none can be submitted',
    );
  });

  it('treats exactly 25 XLM as enough and one stroop less as low', async () => {
    expect(ATTESTOR_LOW_BALANCE_STROOPS).toBe(250_000_000n);

    const enough = harness({ balance: ATTESTOR_LOW_BALANCE_STROOPS });
    expect((await enough.tick(T0)).built).toEqual([]);

    const low = harness({ balance: ATTESTOR_LOW_BALANCE_STROOPS - 1n });
    expect((await low.tick(T0)).built.map((a) => a.key)).toEqual(['attestor_balance_low']);
  });

  it('pages for an account that does not exist on the network, which reads as a balance of zero', async () => {
    const h = harness({ balance: 0n });

    const { sent } = await h.tick(T0);

    expect(sent[0].text).toContain('the attestor account holds 0.0000000 XLM');
  });

  it('stays silent while the balance is healthy', async () => {
    const h = harness({ balance: 500n * XLM });

    const { built, incomplete } = await h.tick(T0);

    expect(built).toEqual([]);
    expect(incomplete.size).toBe(0);
  });

  it('does not repeat itself as the balance drains, because the fingerprint does not carry the balance', async () => {
    const h = harness({ balance: 24n * XLM });

    expect((await h.tick(T0)).sent).toHaveLength(1);
    h.setBalance(23n * XLM);
    expect((await h.tick(new Date(T0.getTime() + 5 * MINUTE))).sent).toEqual([]);
    h.setBalance(1n * XLM);
    expect((await h.tick(new Date(T0.getTime() + 10 * MINUTE))).sent).toEqual([]);
    expect(h.enqueued).toHaveLength(1);
  });

  it('says it is blind when no usable attestor key is configured, rather than reading the absence as a healthy balance', async () => {
    const h = harness({ balance: null });

    const { built, incomplete } = await h.tick(T0);

    expect(incomplete.has('attestor_balance_low')).toBe(true);
    expect(built.map((a) => a.key)).toEqual(['monitoring_blind']);
    expect(built[0].fingerprint).toBe('attestor_balance_low');
  });

  it('says it is blind when the balance cannot be read, rather than reporting a number it does not have', async () => {
    const h = harness({ balance: new Error('the rpc is unreachable') });

    const { built, incomplete } = await h.tick(T0);

    expect(incomplete.has('attestor_balance_low')).toBe(true);
    expect(built.map((a) => a.key)).toEqual(['monitoring_blind']);
  });

  it('is handed the attestor by Nest as the seventh dependency, so the check exists in production and not only in a test that supplies one', async () => {
    const attestor = { nativeBalanceStroops: jest.fn(async () => 1n) };
    const module = await Test.createTestingModule({
      providers: [
        MonitoringService,
        { provide: PrismaService, useValue: {} },
        { provide: AlertsService, useValue: {} },
        { provide: DiditRefusalsService, useValue: {} },
        { provide: OutboxService, useValue: {} },
        { provide: StellarReadService, useValue: {} },
        { provide: AppConfigService, useValue: {} },
        { provide: AttestorService, useValue: attestor },
      ],
    }).compile();

    expect((module.get(MonitoringService) as any).attestor).toBe(attestor);
  });

  it('raises nothing and reports nothing incomplete when no attestor is supplied at all, which only a test can arrange', async () => {
    const h = harness({ attestor: 'absent' });

    const { built, incomplete } = await h.tick(T0);

    expect(built).toEqual([]);
    expect(incomplete.size).toBe(0);
  });
});

describe('the scheduled five-minute check itself pages, not only the pieces driven by hand', () => {
  it('reads the audit rows and the attestor balance in one run and hands both alerts to the outbox', async () => {
    const h = harness({ rows: [notSubmitted('a1', 10)], balance: 1n * XLM });

    await h.svc.checkAndAlert();

    expect(h.auditFindMany).toHaveBeenCalledTimes(1);
    const said = h.enqueued.map((job) => job.payload.text).join(' ');
    expect(said).toContain(`order ${ORDER_ID} (trade ${TRADE_ID}) had an attestation attempt`);
    expect(said).toContain('the attestor account holds 1.0000000 XLM');
  });
});

describe('both families belong to the scope monitoring claims, so they can be raised and cleared', () => {
  it('names them, so a family missing here would be dropped silently by the alerts service', () => {
    expect(MONITORING_ALERT_SCOPE).toContain('attestation_failed');
    expect(MONITORING_ALERT_SCOPE).toContain('attestor_balance_low');
  });
});

describe('a balance is written in lumens without ever passing through a float', () => {
  it.each<[bigint, string]>([
    [0n, '0.0000000'],
    [1n, '0.0000001'],
    [9_999_999n, '0.9999999'],
    [250_000_000n, '25.0000000'],
    [123_456_789n, '12.3456789'],
    [9_007_199_254_740_993n, '900719925.4740993'],
  ])('writes %s stroops as %s', (stroops, written) => {
    expect(formatXlm(stroops)).toBe(written);
  });
});

describe('the log line for an attestor account that cannot be read is true of every way the key can be unusable', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each<[string, string | undefined]>([
    ['unset', undefined],
    ['malformed', 'not-a-stellar-secret'],
    ['well-formed but failing its checksum', `S${'A'.repeat(55)}`],
  ])('says it cannot read the balance when the key is %s, and marks the family incomplete', async (_cause, secret) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const attestor = new AttestorService(
      {
        attestorSecret: secret,
        rpcUrl: 'https://example.invalid',
        escrowContractId: 'CESCROW',
        escrowContractIdsExtra: [],
      } as any,
      {} as any,
    );
    const h = harness({ realAttestor: attestor });

    const { built, incomplete } = await h.tick(T0);

    expect(warn).toHaveBeenCalledWith(
      'no usable attestor key is configured on this coordinator, so the balance of its account cannot be read',
    );
    expect(incomplete.has('attestor_balance_low')).toBe(true);
    expect(built.map((a) => a.key)).toEqual(['monitoring_blind']);
  });
});

describe('a window is named in exact words, never rounded', () => {
  it.each<[number, string]>([
    [1000, 'second'],
    [5000, '5 seconds'],
    [60_000, 'minute'],
    [660_000, '11 minutes'],
    [5_400_000, '90 minutes'],
    [3_600_000, 'hour'],
    [7_200_000, '2 hours'],
    [86_400_000, 'day'],
    [172_800_000, '2 days'],
    [1500, '1500 milliseconds'],
  ])('writes %s ms as %s', (ms, words) => {
    expect(windowWords(ms)).toBe(words);
  });
});

describe('the truncation notice names the window the check really reads', () => {
  afterEach(() => jest.restoreAllMocks());

  it('follows the constant: at 90 minutes the notice says 90 minutes and the query looks back 90 minutes', async () => {
    jest.replaceProperty(conditions, 'ATTESTATION_FAILURE_WINDOW_MS', 90 * MINUTE);
    const full = Array.from({ length: ALERT_SAMPLE_LIMIT }, (_, i) => notSubmitted(`a${String(i).padStart(4, '0')}`, 10));
    const h = harness({ rows: full });

    const { built } = await h.tick(T0);

    expect(built.find((a) => a.key === 'attestation_failed:overflow')!.text).toBe(
      `at least ${ALERT_SAMPLE_LIMIT} attestation attempts in the last 90 minutes — the list is truncated and nothing in this family will be reported as cleared until it is not`,
    );
    expect((h.auditFindMany.mock.calls[0] as any[])[0].where.createdAt.gte).toEqual(
      new Date(T0.getTime() - 90 * MINUTE),
    );
  });
});
