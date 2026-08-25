import { MaintenanceService } from './maintenance.service';

function make(opts: {
  orders?: any[];
  onChain?: any;
  readThrows?: boolean;
  refundConfigured?: boolean;
  autoRefund?: boolean;
}) {
  const raise = jest.fn(async () => ({ sent: [], cleared: [] }));
  const prisma = {
    order: { findMany: jest.fn().mockResolvedValue(opts.orders ?? []) },
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
  );
  return { svc, raise, stellar, prisma };
}

const order = (over: any = {}) => ({
  id: 'ord-1',
  tradeId: 'a'.repeat(64),
  contractId: 'CESCROW',
  status: 'CANCELLED',
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

  it('says nothing about an order the escrow still holds as funded', async () => {
    const { svc, raise } = make({
      orders: [order()],
      onChain: { status: 'FUNDED', settledAt: 0 },
    });
    await svc.alertOnEscrowDivergence();
    expect((raise.mock.calls[0] as any[])[1]).toEqual([]);
  });

  it('says nothing about an order the chain never heard of', async () => {
    const { svc, raise } = make({ orders: [order()], onChain: null });
    await svc.alertOnEscrowDivergence();
    expect((raise.mock.calls[0] as any[])[1]).toEqual([]);
  });

  it('reports a clear sky when nothing diverges, so an earlier alert can be cleared', async () => {
    const { svc, raise } = make({ orders: [] });
    await svc.alertOnEscrowDivergence();
    expect(raise).toHaveBeenCalledWith(['escrow_divergence'], []);
  });

  it('abandons the tick when the chain cannot be read, rather than clearing everything', async () => {
    const { svc, raise } = make({ orders: [order()], readThrows: true });
    await svc.alertOnEscrowDivergence();
    expect(raise).not.toHaveBeenCalled();
  });

  it('abandons the tick when the orders cannot be read', async () => {
    const { svc, raise, prisma } = make({ orders: [] });
    prisma.order.findMany = jest.fn().mockRejectedValue(new Error('db down'));
    await svc.alertOnEscrowDivergence();
    expect(raise).not.toHaveBeenCalled();
  });
});
