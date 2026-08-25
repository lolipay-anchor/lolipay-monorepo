import { MonitoringService } from './monitoring.service';

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
  prisma.alertState = {
    findMany: jest.fn().mockResolvedValue([]),
    upsert: jest.fn(),
    deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  };
  prisma.$transaction = jest.fn().mockResolvedValue([]);
  const cfg = { alertWebhookUrl: opts.webhook } as any;
  return { svc: new MonitoringService(prisma, cfg), prisma };
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

  it('checkAndAlert POSTs the webhook when a threshold trips', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
    const { svc } = make({
      disputes: 1,
      releaseOverdue: 0,
      fiatOverdue: 0,
      indexerAgeMs: 5000,
      webhook: 'https://hooks.example/x',
    });
    await svc.checkAndAlert();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.text).toMatch(/disputed/i);
    expect(body.text).toContain('d0');
    expect(body.text).toContain('td0');
  });

  it('checkAndAlert stays quiet (no webhook) when all clear', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as any;
    const { svc } = make({
      disputes: 0,
      releaseOverdue: 0,
      fiatOverdue: 0,
      indexerAgeMs: 5000,
      webhook: 'https://hooks.example/x',
    });
    await svc.checkAndAlert();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('alerts when the indexer has never run', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    global.fetch = fetchMock as any;
    const { svc } = make({
      disputes: 0,
      releaseOverdue: 0,
      fiatOverdue: 0,
      indexerAgeMs: null,
      webhook: 'https://hooks.example/x',
    });
    await svc.checkAndAlert();
    expect(fetchMock).toHaveBeenCalled()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toMatch(/indexer has never run/i);
  });
});
