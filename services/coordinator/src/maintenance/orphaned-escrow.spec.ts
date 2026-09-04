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

  it('does NOT resurrect the order — the cancel stands, only the funds are recovered', async () => {
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
    const { svc, refundSigner } = make({
      orders: [cancelledOrder({ payDeadline: FUTURE, confirmDeadline: FUTURE })],
      onChain: { status: 'FUNDED', settledAt: 0 },
    });

    await svc.reconcileOrphanedEscrows();

    expect(refundSigner.submitRefund).not.toHaveBeenCalled();
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

describe('the reconciler reads the freshest orphans first and lets a recovered one leave the pool without resurrecting it', () => {
  it('orders candidates newest first and skips rows already carrying a settlement hash', async () => {
    const { svc, prisma } = make();
    await svc.reconcileOrphanedEscrows();
    const args = prisma.order.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args.where.settlementTxHash).toBeNull();
  });

  it('records the refund hash on the row after a recovery, leaving the status as it was', async () => {
    const { svc, prisma } = make({ orders: [cancelledOrder()], onChain: { status: 'FUNDED', settledAt: 0 } });
    await svc.reconcileOrphanedEscrows();
    const writes = prisma.order.updateMany.mock.calls.map((c: any[]) => c[0]);
    expect(writes.some((w: any) => w.data.settlementTxHash === 'h1' && w.data.status === undefined)).toBe(true);
  });
});
