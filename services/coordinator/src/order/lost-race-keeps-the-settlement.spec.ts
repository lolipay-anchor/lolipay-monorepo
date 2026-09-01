import { OrderStatusService, settlementFieldsFrom } from './order-status.service';

const CONTRACT = 'CESCROW';
const TRADE_ID = 'c'.repeat(64);

function onChainRefunded(overrides: any = {}) {
  return {
    status: 'REFUNDED',
    settledAt: 1_800_000_000,
    postSettleDeadline: 1_800_086_400n,
    slashDeadline: 1_800_086_400n,
    liabilityEstablished: true,
    ...overrides,
  } as any;
}

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
        if (where.liabilityEstablished !== undefined && where.liabilityEstablished !== current.liabilityEstablished) {
          return { count: 0 };
        }
        if (where.slashDeadline === null && current.slashDeadline !== null) return { count: 0 };
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

  it('still latches the settlement fields the winner did not write, which nothing would ever retry', async () => {
    const { svc, row } = makeSvc('REFUNDED', onChainRefunded(), {
      status: 'REFUNDED',
      settledAt: new Date(1_800_000_000 * 1000),
    });

    await svc.refreshOrderStatus('order-1', {
      id: 'order-1',
      tradeId: TRADE_ID,
      contractId: CONTRACT,
      status: 'DISPUTED',
    });

    expect(row().liabilityEstablished).toBe(true);
    expect(row().slashDeadline).toBe(1_800_086_400n);
  });

  it('does not touch settledAt when it latches, because the winner already set it from the chain', async () => {
    const settled = new Date(1_800_000_000 * 1000);
    const { svc, writes } = makeSvc('REFUNDED', onChainRefunded({ settledAt: 0 }), {
      status: 'REFUNDED',
      settledAt: settled,
    });

    await svc.refreshOrderStatus('order-1', {
      id: 'order-1',
      tradeId: TRADE_ID,
      contractId: CONTRACT,
      status: 'DISPUTED',
    });

    const latch = writes[writes.length - 1];
    expect(latch.data).not.toHaveProperty('settledAt');
    expect(latch.where).toEqual({
      id: 'order-1',
      status: 'REFUNDED',
      liabilityEstablished: false,
      slashDeadline: null,
    });
  });

  it('refuses to overwrite a verdict another writer already recorded, which the chain read cannot see', async () => {
    const { svc, row } = makeSvc('REFUNDED', onChainRefunded({ liabilityEstablished: false, slashDeadline: 1n }), {
      status: 'REFUNDED',
      settledAt: new Date(1_800_000_000 * 1000),
      liabilityEstablished: true,
      slashDeadline: 2_000_000_000n,
    });

    await svc.refreshOrderStatus('order-1', {
      id: 'order-1',
      tradeId: TRADE_ID,
      contractId: CONTRACT,
      status: 'DISPUTED',
    });

    expect(row().liabilityEstablished).toBe(true);
    expect(row().slashDeadline).toBe(2_000_000_000n);
  });

  it('latches settledAt only when the row has none and the chain carries a real one', async () => {
    const { svc, row } = makeSvc('REFUNDED', onChainRefunded(), {
      status: 'REFUNDED',
      settledAt: null,
    });

    await svc.refreshOrderStatus('order-1', {
      id: 'order-1',
      tradeId: TRADE_ID,
      contractId: CONTRACT,
      status: 'DISPUTED',
    });

    expect(row().settledAt).toEqual(new Date(1_800_000_000 * 1000));
  });

  it('latches nothing at a status that carries no settlement, so an ordinary overtake writes once', async () => {
    const { svc, writes } = makeSvc('FIAT_PAID', { status: 'FIAT_PAID' } as any);

    await svc.refreshOrderStatus('order-1', { id: 'order-1', tradeId: TRADE_ID, contractId: CONTRACT, status: 'FUNDED' });

    expect(writes).toHaveLength(1);
    expect(settlementFieldsFrom({ status: 'FIAT_PAID' } as any)).toEqual({});
  });
});
