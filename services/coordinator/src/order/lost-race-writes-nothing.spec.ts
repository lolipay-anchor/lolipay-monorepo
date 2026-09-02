import { OrderStatusService, settlementFieldsFrom } from './order-status.service';

const CONTRACT = 'CESCROW';
const TRADE_ID = 'c'.repeat(64);

function makeSvc(rowStatus: string, onChain: any, seed: any = {}) {
  let current: any = {
    id: 'order-1',
    tradeId: TRADE_ID,
    contractId: CONTRACT,
    status: rowStatus,
    settledAt: new Date(1_700_000_000 * 1000),
    liabilityEstablished: false,
    slashDeadline: null,
    lp: { id: 'lp-1' },
    ...seed,
  };
  const writes: any[] = [];
  const prisma: any = {
    order: {
      findUnique: jest.fn().mockImplementation(async () => current),
      updateMany: jest.fn().mockImplementation(async ({ where, data }: any) => {
        writes.push({ where, data });
        if (where.id !== current.id) return { count: 0 };
        if (where.status !== undefined && where.status !== current.status) return { count: 0 };
        current = { ...current, ...data };
        return { count: 1 };
      }),
    },
  };
  const stellar: any = { getTradeStatus: jest.fn().mockResolvedValue(onChain) };
  const realtime: any = { emitOrderUpdate: jest.fn() };
  const svc = new OrderStatusService(prisma, stellar, { escrowContractId: CONTRACT } as any, realtime);
  return { svc, prisma, realtime, writes, row: () => current };
}

describe('when another writer reaches the row first', () => {
  it('does not push the status back to what this caller thought it was', async () => {
    const { svc, realtime, row, writes } = makeSvc('DISPUTED', { status: 'FIAT_PAID' } as any);

    await svc.refreshOrderStatus('order-1', {
      id: 'order-1',
      tradeId: TRADE_ID,
      contractId: CONTRACT,
      status: 'FUNDED',
    });

    expect(writes).toHaveLength(1);
    expect(row().status).toBe('DISPUTED');
    expect(realtime.emitOrderUpdate).not.toHaveBeenCalled();
  });

  it('emits nothing for a write that did not happen', async () => {
    const { svc, realtime } = makeSvc('FIAT_PAID', { status: 'FIAT_PAID' } as any);

    await svc.refreshOrderStatus('order-1', { id: 'order-1', tradeId: TRADE_ID, contractId: CONTRACT, status: 'FUNDED' });

    expect(realtime.emitOrderUpdate).not.toHaveBeenCalled();
  });

  it('writes exactly once and never twice, so a lost race costs nothing beyond the write', async () => {
    const { svc, writes } = makeSvc('FIAT_PAID', { status: 'FIAT_PAID' } as any);

    await svc.refreshOrderStatus('order-1', { id: 'order-1', tradeId: TRADE_ID, contractId: CONTRACT, status: 'FUNDED' });

    expect(writes).toHaveLength(1);
    expect(settlementFieldsFrom({ status: 'FIAT_PAID' } as any)).toEqual({});
  });
});
