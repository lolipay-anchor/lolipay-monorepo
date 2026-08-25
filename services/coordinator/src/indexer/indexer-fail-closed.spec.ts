import { nativeToScVal, xdr } from '@stellar/stellar-sdk';
import { IndexerService } from './indexer.service';

const TRADE_ID_A = 'a'.repeat(64);
const TOPIC_DISPUTED = xdr.ScVal.scvSymbol('disputed');
const TOPIC_RESOLVED = xdr.ScVal.scvSymbol('resolved');
const TOPIC_TRADE_CREATED = xdr.ScVal.scvSymbol('trade_created');
const VALUE_EMPTY = nativeToScVal(null);

function tradeIdTopic(hex: string) {
  return xdr.ScVal.scvBytes(Buffer.from(hex, 'hex'));
}

function makeOrder(status: string, overrides: Record<string, any> = {}) {
  return {
    id: 'ord-1',
    tradeId: TRADE_ID_A,
    contractId: 'CXXX',
    status,
    flow: 'TOP_UP',
    userAddress: 'GUSER',
    lpWallet: 'GLP',
    platformWallet: 'GPLAT',
    usdcAmount: 1000n,
    fiatAmount: 16000n,
    fiatCurrency: 'IDR',
    platformFeeBps: 30,
    lpFeeBps: 120,
    payDeadline: 1n,
    confirmDeadline: 2n,
    disputeDeadline: 3n,
    ...overrides,
  };
}

function make(status: string, stellarOverrides: Record<string, any> = {}, orderOverrides = {}) {
  const order = makeOrder(status, orderOverrides);
  const prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue(order),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    indexerState: { upsert: jest.fn().mockResolvedValue({}) },
  } as any;
  const cfg = { rpcUrl: 'x', escrowContractId: 'CXXX', escrowContractIdsExtra: [] } as any;
  const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
  const stellar = {
    getTradeStatus: jest.fn(),
    getTradeStatusStrict: jest.fn(),
    ...stellarOverrides,
  } as any;
  const userReputation = { recordDisputeLost: jest.fn().mockResolvedValue(undefined) } as any;
  return {
    svc: new IndexerService(prisma, cfg, notifications, stellar, userReputation) as any,
    prisma,
    stellar,
    notifications,
  };
}

describe('the indexer refuses to lose an event it could not verify', () => {
  it('a post-settlement dispute whose chain read fails throws, so the cursor cannot advance past it', async () => {
    const { svc, prisma } = make('RELEASED', {
      getTradeStatusStrict: jest.fn().mockRejectedValue(new Error('rpc down')),
    });

    await expect(
      svc.applyEvent({
        topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
        value: nativeToScVal({ by: 'GUSER' }),
        contractId: 'CXXX',
      }),
    ).rejects.toThrow('rpc down');

    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('index() leaves the cursor where it was when applying an event threw', async () => {
    const getEvents = jest.fn().mockResolvedValue({
      events: [{ topic: [], value: VALUE_EMPTY, contractId: 'CXXX' }],
      cursor: 'CURSOR-AFTER-THE-DISPUTE',
      latestLedger: 1000,
    });
    const getLatestLedger = jest.fn().mockResolvedValue({ sequence: 1000 });

    jest.resetModules();
    jest.doMock('@stellar/stellar-sdk/rpc', () => {
      const actual = jest.requireActual('@stellar/stellar-sdk/rpc');
      return { ...actual, Server: jest.fn().mockImplementation(() => ({ getEvents, getLatestLedger })) };
    });
    const { IndexerService: MockedIndexerService } = require('./indexer.service');

    const prisma = {
      indexerState: {
        findUnique: jest.fn().mockResolvedValue({ cursor: 'CUR1' }),
        upsert: jest.fn().mockResolvedValue(undefined),
      },
      order: { findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    } as any;
    const cfg = { rpcUrl: 'x', escrowContractId: 'CXXX', escrowContractIdsExtra: [] } as any;
    const svc = new MockedIndexerService(
      prisma,
      cfg,
      { notifyOrderStatus: jest.fn() } as any,
      { getTradeStatus: jest.fn(), getTradeStatusStrict: jest.fn() } as any,
      { recordDisputeLost: jest.fn() } as any,
    ) as any;

    svc.applyEvent = jest.fn().mockRejectedValue(new Error('rpc down'));

    await svc.poll();

    expect(getEvents).toHaveBeenCalled();
    expect(svc.applyEvent).toHaveBeenCalled();
    expect(prisma.indexerState.upsert).not.toHaveBeenCalled();
    expect(svc.running).toBe(false);
  });

  it('an ordinary settlement still advances when only the timestamp read failed', async () => {
    const { svc, prisma } = make('DISPUTED', {
      getTradeStatus: jest.fn().mockRejectedValue(new Error('rpc down')),
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ released: true, post_settle: false }),
      contractId: 'CXXX',
    });
    expect(advanced).toBe(1);
    expect(prisma.order.updateMany).toHaveBeenCalled();
  });
});

describe('a dispute cannot act on an order whose trade was never verified', () => {
  it('runs the trade/order binding check before a disputed event on an unbound order', async () => {
    const mismatched = {
      status: 'FUNDED',
      settledAt: 0,
      usdcAmount: 1n,
      fiatAmount: 1n,
      fiatCurrency: 'IDR',
      flow: 0,
      usdcProvider: 'GATTACKER',
      usdcRecipient: 'GATTACKER',
      confirmer: 'GATTACKER',
      platformWallet: 'GATTACKER',
      lpWallet: 'GATTACKER',
      platformFeeBps: 0,
      lpFeeBps: 0,
      payDeadline: 9n,
      confirmDeadline: 9n,
      disputeDeadline: 9n,
    };
    const { svc, prisma, stellar } = make('MATCHED', {
      getTradeStatusStrict: jest.fn().mockResolvedValue(mismatched),
    });

    const advanced = await svc.applyEvent({
      topic: [TOPIC_DISPUTED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ by: 'GATTACKER' }),
      contractId: 'CXXX',
    });

    expect(stellar.getTradeStatusStrict).toHaveBeenCalled();
    expect(advanced).toBe(0);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('applies the same check to a resolved event on an unbound order', async () => {
    const { svc, prisma, stellar } = make('MATCHED', {
      getTradeStatusStrict: jest.fn().mockResolvedValue(null),
    });
    const advanced = await svc.applyEvent({
      topic: [TOPIC_RESOLVED, tradeIdTopic(TRADE_ID_A)],
      value: nativeToScVal({ released: true, post_settle: false }),
      contractId: 'CXXX',
    });
    expect(stellar.getTradeStatusStrict).toHaveBeenCalled();
    expect(advanced).toBe(0);
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });
});
