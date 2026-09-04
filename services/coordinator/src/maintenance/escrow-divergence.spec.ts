import 'reflect-metadata';
import { CronExpression } from '@nestjs/schedule';
import { MaintenanceService, RECONCILER_PERIOD_SECS } from './maintenance.service';

function make(opts: {
  poolSize?: number;
  orders?: any[];
  onChain?: any;
  readThrows?: boolean;
  refundConfigured?: boolean;
  autoRefund?: boolean;
}) {
  const raise = jest.fn(async () => ({ sent: [], cleared: [] }));
  const prisma = {
    order: { findMany: jest.fn().mockResolvedValue(opts.orders ?? []), count: jest.fn().mockResolvedValue(opts.poolSize ?? (opts.orders ?? []).length) },
    config: {
      findUnique: jest.fn().mockResolvedValue({ id: 1, autoRefund: opts.autoRefund ?? false }),
    },
  } as any;
  const stellar = {
    getTradeStatusStrict: opts.readThrows
      ? jest.fn().mockRejectedValue(new Error('rpc down'))
      : jest.fn().mockResolvedValue(opts.onChain ?? null),
  } as any;
  const svc = new MaintenanceService(
    prisma,
    stellar,
    { isConfigured: opts.refundConfigured ?? false } as any,
    { escrowContractId: 'CESCROW' } as any,
    { notifyOrderStatus: jest.fn() } as any,
    { raise } as any,
    { prune: jest.fn(async () => 0), stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })) } as any,
  );
  return { svc, raise, stellar, prisma };
}

const order = (over: any = {}) => ({
  id: 'ord-1',
  tradeId: 'a'.repeat(64),
  contractId: 'CESCROW',
  status: 'CANCELLED',
  createdAt: new Date(),
  flow: 'TOP_UP',
  payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
  confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
  ...over,
});

describe('an order the chain disagrees about reaches a human', () => {
  it('raises an urgent alert naming both sides of the disagreement', async () => {
    const { svc, raise } = make({
      orders: [order()],
      onChain: { status: 'FIAT_PAID', settledAt: 0 },
    });

    await svc.alertOnEscrowDivergence();

    expect(raise).toHaveBeenCalledTimes(1);
    const [scope, alerts] = raise.mock.calls[0] as any[];
    expect(scope).toEqual(['escrow_divergence']);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].key).toBe('escrow_divergence:ord-1');
    expect(alerts[0].urgency).toBe('urgent');
    expect(alerts[0].text).toContain('CANCELLED');
    expect(alerts[0].text).toContain('FIAT_PAID');
  });

  it('runs even when auto-refund is off and no refund signer exists', async () => {
    const { svc, raise } = make({
      orders: [order()],
      onChain: { status: 'RELEASED', settledAt: 0 },
      autoRefund: false,
      refundConfigured: false,
    });

    await svc.alertOnEscrowDivergence();

    expect(raise).toHaveBeenCalledTimes(1);
    expect((raise.mock.calls[0] as any[])[1]).toHaveLength(1);
  });

  it('keeps a funded escrow behind an EXPIRED row in the list at routine urgency while the reconciler will act on it, so a later flip of the switch cannot clear an alert nothing on chain resolved', async () => {
    const { svc, raise } = make({
      orders: [order({ status: 'EXPIRED' })],
      onChain: { status: 'FUNDED', settledAt: 0 },
      autoRefund: true,
      refundConfigured: true,
    });
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    expect(found).toHaveLength(1);
    expect(found[0].urgency).toBe('routine');
    expect(found[0].text).toMatch(/FUNDED on chain/);
    expect(found[0].fingerprint).toMatch(/^FUNDED:/);
  });

  it('turns urgent once the refund instant plus one reconciler period has passed with the escrow still funded, because that is proof the reconciler did not act, whatever the switches say', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const { svc, raise } = make({
      orders: [order({ status: 'EXPIRED', payDeadline: BigInt(past - 7200), confirmDeadline: BigInt(past) })],
      onChain: { status: 'FUNDED', settledAt: 0 },
      autoRefund: true,
      refundConfigured: true,
    });
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    expect(found[0].urgency).toBe('urgent');
    expect(found[0].text).toMatch(/reconciler did not act/i);
    expect(found[0].fingerprint).toBe('FUNDED:missed');
  });

  it('gives the reconciler one period per twenty rows of its pool plus one before calling it missed, so a queued orphan is not paged as neglected', async () => {
    const now = Math.floor(Date.now() / 1000);
    const refundAt = now - RECONCILER_PERIOD_SECS - 30;
    const { svc, raise } = make({
      orders: [order({ status: 'EXPIRED', payDeadline: BigInt(refundAt - 3600), confirmDeadline: BigInt(refundAt) })],
      onChain: { status: 'FUNDED', settledAt: 0 },
      autoRefund: true,
      refundConfigured: true,
    });
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    expect(found[0].urgency).toBe('routine');
    expect(found[0].fingerprint).toBe('FUNDED:reconciler');
  });

  it('scales the walk allowance with the reconciler pool it counts, not with the scan: a pool of forty-one needs four periods before an orphan counts as missed', async () => {
    const now = Math.floor(Date.now() / 1000);
    const refundAt = now - 3 * RECONCILER_PERIOD_SECS - 30;
    const { svc, raise, prisma } = make({
      orders: [order({ status: 'EXPIRED', payDeadline: BigInt(refundAt - 3600), confirmDeadline: BigInt(refundAt) })],
      poolSize: 41,
      onChain: { status: 'FUNDED', settledAt: 0 },
      autoRefund: true,
      refundConfigured: true,
    });
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    expect(found[0].fingerprint).toBe('FUNDED:reconciler');
    const where = prisma.order.count.mock.calls[0][0].where;
    expect(where.status).toEqual({ in: ['CANCELLED', 'EXPIRED'] });
    expect(where.settlementTxHash).toBeNull();
    expect(where.OR[1]).toEqual({ flow: 'TOP_UP', payDeadline: { lt: where.OR[0].confirmDeadline.lt - 3600n } });
  });

  it('a wide scan over a small reconciler pool does not stretch the allowance: four hundred never-funded rows in the scan and a pool of one still page a four-hour-old orphan', async () => {
    const now = Math.floor(Date.now() / 1000);
    const refundAt = now - 4 * 3600;
    const filler = Array.from({ length: 400 }, (_, i) => order({ id: `f${i}`, tradeId: `${i}`.padStart(64, '0'), status: 'CANCELLED' }));
    const { svc, raise, stellar } = make({
      orders: [order({ status: 'EXPIRED', payDeadline: BigInt(refundAt - 3600), confirmDeadline: BigInt(refundAt) }), ...filler],
      poolSize: 1,
      onChain: { status: 'FUNDED', settledAt: 0 },
      autoRefund: true,
      refundConfigured: true,
    });
    stellar.getTradeStatusStrict.mockImplementation(async (_c: string, tradeId: string) => (tradeId === 'a'.repeat(64) ? { status: 'FUNDED', settledAt: 0 } : null));
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    expect(found).toHaveLength(1);
    expect(found[0].fingerprint).toBe('FUNDED:missed');
  });

  it('a row whose alert cannot be composed still reaches a human, and never takes the rest of the family down with it', async () => {
    const { svc, raise } = make({
      orders: [order({ id: 'o1', status: 'EXPIRED', confirmDeadline: BigInt('9'.repeat(18)), payDeadline: BigInt('9'.repeat(18)) }), order({ id: 'o2', tradeId: 'b'.repeat(64), status: 'EXPIRED' })],
      onChain: { status: 'FUNDED', settledAt: 0 },
      autoRefund: false,
      refundConfigured: false,
    });
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    expect(found.map((a: any) => a.key).sort()).toEqual(['escrow_divergence:o1', 'escrow_divergence:o2']);
    expect(found.find((a: any) => a.key === 'escrow_divergence:o1').text).toMatch(/could not be composed/);
    expect(((raise.mock.calls[0] as any[])[2] as Set<string>).has('escrow_divergence')).toBe(false);
    expect(found.find((a: any) => a.key === 'escrow_divergence:o2').text).toMatch(/autoRefund is off/);
  });

  it('the period the alert assumes is the cron the reconciler actually runs on', () => {
    const meta = Reflect.getMetadata('SCHEDULE_CRON_OPTIONS', MaintenanceService.prototype.reconcileOrphanedEscrows);
    expect(meta.cronTime).toBe(CronExpression.EVERY_10_MINUTES);
    expect(RECONCILER_PERIOD_SECS).toBe(600);
  });

  it('pages when the order query itself fails, because a scan that cannot run is blindness, not agreement', async () => {
    const { svc, raise, prisma } = make({ orders: [] });
    prisma.order.findMany.mockRejectedValueOnce(new Error('db down'));
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    const incomplete = (raise.mock.calls[0] as any[])[2] as Set<string>;
    expect(found.map((a: any) => a.key)).toEqual(['escrow_divergence:unreadable']);
    expect(found[0].urgency).toBe('urgent');
    expect(found[0].text).toMatch(/db down/);
    expect(incomplete.has('escrow_divergence')).toBe(true);
  });

  it('names the instant the refund opens and who the USDC returns to, so the operator knows when refund\(\) will be accepted', async () => {
    const { svc, raise } = make({
      orders: [order({ status: 'EXPIRED', flow: 'WITHDRAW' })],
      onChain: { status: 'FUNDED', settledAt: 0 },
      autoRefund: false,
      refundConfigured: false,
    });
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    expect(found[0].text).toMatch(/opens at \d{4}-\d{2}-\d{2}T/);
    expect(found[0].text).toMatch(/usdc_provider, the user$/);
  });

  it('on a deposit the USDC returns to the provider, and the alert says so', async () => {
    const { svc, raise } = make({
      orders: [order({ status: 'EXPIRED', flow: 'TOP_UP' })],
      onChain: { status: 'FUNDED', settledAt: 0 },
      autoRefund: false,
      refundConfigured: false,
    });
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    expect(found[0].text).toMatch(/usdc_provider, the provider$/);
  });

  it('names an order the escrow holds as funded when no reconciler will act, as urgent, with the permissionless refund and the switch that is off', async () => {
    const { svc, raise } = make({
      orders: [order({ status: 'EXPIRED' })],
      onChain: { status: 'FUNDED', settledAt: 0 },
      autoRefund: false,
      refundConfigured: true,
    });
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    expect(found[0].urgency).toBe('urgent');
    expect(found[0].text).toMatch(/refund\(/);
    expect(found[0].text).toMatch(/autoRefund is off/);
    expect(found[0].text).not.toMatch(/no refund signer/);
  });

  it('says which condition is missing when it is the signer', async () => {
    const { svc, raise } = make({
      orders: [order({ status: 'EXPIRED' })],
      onChain: { status: 'FUNDED', settledAt: 0 },
      autoRefund: true,
      refundConfigured: false,
    });
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    expect(found[0].urgency).toBe('urgent');
    expect(found[0].text).toMatch(/no refund signer/);
  });

  it('treats a funded escrow older than the reconciler lookback as urgent even with both switches on, because the reconciler will never see it', async () => {
    const { svc, raise } = make({
      orders: [order({ status: 'EXPIRED', createdAt: new Date(Date.now() - 46 * 86_400_000) })],
      onChain: { status: 'FUNDED', settledAt: 0 },
      autoRefund: true,
      refundConfigured: true,
    });
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    expect(found[0].urgency).toBe('urgent');
    expect(found[0].text).toMatch(/older than the reconciler/);
  });

  it('fails closed when the config row cannot be read: the funded escrow is reported as urgent rather than assumed handled', async () => {
    const { svc, raise, prisma } = make({
      orders: [order({ status: 'EXPIRED' })],
      onChain: { status: 'FUNDED', settledAt: 0 },
      refundConfigured: true,
    });
    prisma.config.findUnique.mockRejectedValueOnce(new Error('db down'));
    await svc.alertOnEscrowDivergence();
    const found = (raise.mock.calls[0] as any[])[1];
    expect(found[0].urgency).toBe('urgent');
    expect(found[0].text).toMatch(/config row could not be read/i);
    expect(found[0].text).not.toMatch(/autoRefund is off/);
  });

  it('says nothing about an order the chain never heard of', async () => {
    const { svc, raise } = make({ orders: [order()], onChain: null });
    await svc.alertOnEscrowDivergence();
    expect((raise.mock.calls[0] as any[])[1]).toEqual([]);
  });

  it('reports a clear sky when nothing diverges, so an earlier alert can be cleared', async () => {
    const { svc, raise } = make({ orders: [] });
    await svc.alertOnEscrowDivergence();
    const [scope, alerts, incomplete] = raise.mock.calls[0] as any[];
    expect(scope).toEqual(['escrow_divergence']);
    expect(alerts).toEqual([]);
    expect(incomplete.size).toBe(0);
  });

  it('marks the family incomplete when a chain read fails, so nothing is cleared on a blind tick', async () => {
    const { svc, raise } = make({ orders: [order()], readThrows: true });
    await svc.alertOnEscrowDivergence();
    const [, , incomplete] = raise.mock.calls[0] as any[];
    expect(incomplete.has('escrow_divergence')).toBe(true);
  });

  it('keeps going past an unreadable order rather than losing the ones it can see', async () => {
    const raise = jest.fn(async () => ({ sent: [], cleared: [] }));
    const prisma = {
      order: {
        findMany: jest
          .fn()
          .mockResolvedValue([order({ id: 'bad' }), order({ id: 'good' })]),
      },
      config: { findUnique: jest.fn().mockResolvedValue({ id: 1, autoRefund: false }) },
    } as any;
    const stellar = {
      getTradeStatusStrict: jest
        .fn()
        .mockRejectedValueOnce(new Error('rpc down'))
        .mockResolvedValueOnce({ status: 'RELEASED', settledAt: 0 }),
    } as any;
    const svc = new MaintenanceService(
      prisma,
      stellar,
      { isConfigured: false } as any,
      { escrowContractId: 'CESCROW' } as any,
      { notifyOrderStatus: jest.fn() } as any,
      { raise } as any,
      { prune: jest.fn(async () => 0), stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })) } as any,
    );

    await svc.alertOnEscrowDivergence();

    const [, alerts, incomplete] = raise.mock.calls[0] as any[];
    expect(alerts.map((a: any) => a.key)).toEqual(['escrow_divergence:good']);
    expect(incomplete.has('escrow_divergence')).toBe(true);
  });

  it('refuses to clear anything when the scan came back full', async () => {
    const many = Array.from({ length: 500 }, (_, i) => order({ id: `o${i}` }));
    const { svc, raise } = make({ orders: many, onChain: { status: 'FUNDED', settledAt: 0 } });
    await svc.alertOnEscrowDivergence();
    const [, alerts, incomplete] = raise.mock.calls[0] as any[];
    expect(incomplete.has('escrow_divergence')).toBe(true);
    expect(alerts.map((a: any) => a.key)).toContain('escrow_divergence:overflow');
  });

  it('asks the database for a deterministically ordered scan', async () => {
    const { svc, prisma } = make({ orders: [] });
    await svc.alertOnEscrowDivergence();
    const args = prisma.order.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(args.take).toBe(500);
  });

});

describe('the reconciler own success is not a divergence', () => {
  it('says nothing about an escrow the orphan reconciler already refunded', async () => {
    const { svc, raise } = make({
      orders: [order()],
      onChain: { status: 'REFUNDED', settledAt: 0 },
    });
    await svc.alertOnEscrowDivergence();
    expect((raise.mock.calls[0] as any[])[1]).toEqual([]);
  });

  it('still pages when the money went somewhere the order never authorised', async () => {
    for (const status of ['RELEASED', 'FIAT_PAID', 'DISPUTED']) {
      const { svc, raise } = make({ orders: [order()], onChain: { status, settledAt: 0 } });
      await svc.alertOnEscrowDivergence();
      const alerts = (raise.mock.calls[0] as any[])[1];
      expect(alerts).toHaveLength(1);
      expect(alerts[0].text).toContain(status);
    }
  });

  it('scans every cancelled order, not a recent window, because it clears by absence', async () => {
    const { svc, prisma } = make({ orders: [] });
    await svc.alertOnEscrowDivergence();
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ status: { in: ['CANCELLED', 'EXPIRED'] } });
    expect(JSON.stringify(where)).not.toContain('createdAt');
  });
});
