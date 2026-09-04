import { Logger } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';

const PAST = BigInt(Math.floor(Date.now() / 1000) - 60);
const FUTURE = BigInt(Math.floor(Date.now() / 1000) + 3600);

function make(opts: {
  orders?: any[];
  onChain?: any;
  refundConfigured?: boolean;
  refundResult?: any;
} = {}) {
  const prisma = {
    order: {
      findMany: jest.fn().mockResolvedValue(opts.orders ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: jest.fn(async (ops: unknown[]) => Promise.all(ops)),
    quote: { deleteMany: jest.fn() },
    config: { findUnique: jest.fn().mockResolvedValue({ autoRefund: true }) },
  } as any;
  const stellar = {
    getTradeStatusStrict: jest.fn().mockResolvedValue(opts.onChain ?? null),
  } as any;
  const refundSigner = {
    isConfigured: opts.refundConfigured ?? true,
    publicKey: 'GREFUND',
    submitRefund: jest.fn().mockResolvedValue(opts.refundResult ?? { status: 'SUCCESS', hash: 'h1' }),
  } as any;
  const cfg = { escrowContractId: 'CESCROW' } as any;
  const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
  return {
    svc: new MaintenanceService(prisma, stellar, refundSigner, cfg, notifications, { raise: jest.fn(async () => ({ sent: [], cleared: [] })) } as any, { prune: jest.fn(async () => 0), stuckCounts: jest.fn(async () => ({ failed: 0, stalled: 0 })) } as any),
    prisma,
    stellar,
    refundSigner,
  };
}

const cancelledOrder = (over: any = {}) => ({
  id: 'o1',
  tradeId: 'a'.repeat(64),
  contractId: 'CESCROW',
  status: 'CANCELLED',
  flow: 'WITHDRAW',
  payDeadline: PAST,
  confirmDeadline: PAST,
  ...over,
});

describe('MaintenanceService.reconcileOrphanedEscrows (X3)', () => {
  it('recovers a funded escrow left behind by a cancel that raced it', async () => {
    const { svc, refundSigner } = make({
      orders: [cancelledOrder()],
      onChain: { status: 'FUNDED', settledAt: 0 },
    });

    await svc.reconcileOrphanedEscrows();

    expect(refundSigner.submitRefund).toHaveBeenCalledWith('CESCROW', 'a'.repeat(64));
  });

  it('writes no status of its own: the cancel stands here, and only the indexer may later move the row to REFUNDED on the refunded event', async () => {
    const { svc, prisma } = make({
      orders: [cancelledOrder()],
      onChain: { status: 'FUNDED', settledAt: 0 },
    });

    await svc.reconcileOrphanedEscrows();

    const statusWrites = prisma.order.updateMany.mock.calls
      .map((c: any[]) => c[0]?.data?.status)
      .filter(Boolean);
    expect(statusWrites).not.toContain('FUNDED');
  });

  it('leaves an orphan alone until the escrow would accept a refund, since it would revert', async () => {
    const { svc, refundSigner, stellar } = make({
      orders: [cancelledOrder({ payDeadline: FUTURE, confirmDeadline: FUTURE })],
      onChain: { status: 'FUNDED', settledAt: 0 },
    });

    await svc.reconcileOrphanedEscrows();

    expect(refundSigner.submitRefund).not.toHaveBeenCalled();
    expect(stellar.getTradeStatusStrict).not.toHaveBeenCalled();
  });

  it('does nothing for a cancelled order that never reached the chain', async () => {
    const { svc, refundSigner } = make({ orders: [cancelledOrder()], onChain: null });
    await svc.reconcileOrphanedEscrows();
    expect(refundSigner.submitRefund).not.toHaveBeenCalled();
  });

  it('refuses to refund when the escrow has moved past FUNDED', async () => {
    const { svc, refundSigner } = make({
      orders: [cancelledOrder()],
      onChain: { status: 'FIAT_PAID', settledAt: 0 },
    });

    await svc.reconcileOrphanedEscrows();

    expect(refundSigner.submitRefund).not.toHaveBeenCalled();
  });

  it('is fail-closed when the refund signer is not configured', async () => {
    const { svc, refundSigner } = make({
      orders: [cancelledOrder()],
      onChain: { status: 'FUNDED', settledAt: 0 },
      refundConfigured: false,
    });

    await svc.reconcileOrphanedEscrows();

    expect(refundSigner.submitRefund).not.toHaveBeenCalled();
  });

  it('only considers terminal off-chain statuses', async () => {
    const { svc, prisma } = make();
    await svc.reconcileOrphanedEscrows();
    const where = prisma.order.findMany.mock.calls[0][0].where;
    expect(where.status.in).toEqual(['CANCELLED', 'EXPIRED']);
  });
});

describe('the reconciler walks the whole refundable pool a page at a time and lets a recovered one leave it', () => {
  it('asks only for rows whose refund instant has passed and that carry no settlement, oldest first', async () => {
    const { svc, prisma } = make();
    const before = BigInt(Math.floor(Date.now() / 1000));
    await svc.reconcileOrphanedEscrows();
    const args = prisma.order.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    expect(args.where.settlementTxHash).toBeNull();
    expect(args.where.settledAt).toBeNull();
    expect(args.where.OR[0].confirmDeadline.lt).toBeGreaterThanOrEqual(before);
    expect(args.where.OR[0].confirmDeadline.lt).toBeLessThanOrEqual(BigInt(Math.floor(Date.now() / 1000)));
    expect(args.where.OR[1]).toEqual({ flow: 'TOP_UP', payDeadline: { lt: args.where.OR[0].confirmDeadline.lt - 3600n } });
    expect(args.where.AND).toBeUndefined();
  });

  it('continues after a full page on the next tick and starts over after a short one, so no row is starved by the ones ahead of it', async () => {
    const page = Array.from({ length: 20 }, (_, i) => cancelledOrder({ id: `o${i}`, createdAt: new Date(1_700_000_000_000 + i) }));
    const { svc, prisma } = make({ orders: page });
    await svc.reconcileOrphanedEscrows();
    prisma.order.findMany.mockResolvedValueOnce([cancelledOrder({ id: 'o99', createdAt: new Date(1_700_000_001_000) })]);
    await svc.reconcileOrphanedEscrows();
    const second = prisma.order.findMany.mock.calls[1][0];
    expect(second.where.AND[0].OR[0]).toEqual({ createdAt: { gt: new Date(1_700_000_000_019) } });
    expect(second.where.AND[0].OR[1]).toEqual({ createdAt: new Date(1_700_000_000_019), id: { gt: 'o19' } });
    prisma.order.findMany.mockResolvedValueOnce([]);
    await svc.reconcileOrphanedEscrows();
    expect(prisma.order.findMany.mock.calls[2][0].where.AND).toBeUndefined();
  });

  it('records the refund hash on the row after a recovery, leaving the status as it was', async () => {
    const { svc, prisma } = make({ orders: [cancelledOrder()], onChain: { status: 'FUNDED', settledAt: 0 } });
    await svc.reconcileOrphanedEscrows();
    const writes = prisma.order.updateMany.mock.calls.map((c: any[]) => c[0]);
    expect(writes).toEqual([
      { where: { id: 'o1', settlementTxHash: null }, data: { settlementTxHash: 'h1' } },
      { where: { id: 'o1', settledAt: null }, data: { settledAt: expect.any(Date) } },
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
