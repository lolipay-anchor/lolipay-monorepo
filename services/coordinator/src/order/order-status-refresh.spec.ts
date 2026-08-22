import { OrderService } from './order.service';
import { makeUserReputationStub, onChainTradeFor, orderStatusFor, orderTxFor } from './test-helpers';

const USER_ADDR = 'GUSER';
const LP_ADDR = 'GLP';
const PLATFORM = 'GPLATFORM';
const CONTRACT = 'CESCROW';
const TRADE_ID = 'b'.repeat(64);

function makeOrder(overrides: Partial<any> = {}): any {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: 'order-1',
    tradeId: TRADE_ID,
    contractId: CONTRACT,
    userAddress: USER_ADDR,
    flow: 'TOP_UP',
    status: 'MATCHED',
    fiatCurrency: 'IDR',
    usdcAmount: BigInt('10000000000'),
    fiatAmount: BigInt('163000000'),
    platformFeeBps: 30,
    lpFeeBps: 120,
    platformWallet: PLATFORM,
    lpWallet: LP_ADDR,
    lpId: 'lp-1',
    lpPaymentDetails: 'BCA 1234567890 a/n Provider',
    payDeadline: BigInt(now + 1800),
    confirmDeadline: BigInt(now + 3600),
    disputeDeadline: BigInt(now + 7200),
    lp: { id: 'lp-1', stellarAddress: LP_ADDR, approvedAt: new Date(), createdAt: new Date(), online: true },
    ...overrides,
  };
}

function makeSvc(orderOverrides: Partial<any> = {}, onChainStatus: string | null = null) {
  const order = makeOrder(orderOverrides);
  const onChain = onChainStatus ? onChainTradeFor(order, onChainStatus) : null;
  const prisma = {
    order: {
      findUnique: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockImplementation(async ({ data }: any) => ({ ...order, ...data })),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    config: {
      upsert: jest.fn().mockResolvedValue({ postSettleDisputeWindowSecs: 3600, requireProof: true }),
    },
    lp: { findUnique: jest.fn().mockResolvedValue({ id: 'lp-1', stellarAddress: LP_ADDR }) },
  } as any;

  const stellar = {
    getTradeStatus: jest.fn().mockResolvedValue(onChain),
    getTradeStatusStrict: jest.fn().mockResolvedValue(onChain),
  } as any;

  const cfg = { platformWallet: PLATFORM, escrowContractId: CONTRACT } as any;
  const svc = new OrderService(
    prisma,
    stellar,
    { pickLp: jest.fn() } as any,
    cfg,
    { getEnabled: jest.fn() } as any,
    { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any,
    {} as any,
    makeUserReputationStub(),
    orderStatusFor(prisma, stellar, cfg), orderTxFor(prisma, stellar, cfg),

  );
  return { svc, prisma, stellar, order };
}

describe('refreshing an order status from the chain', () => {
  it('writes the chain status back when the chain is ahead of the database', async () => {
    const { svc, prisma } = makeSvc({ status: 'MATCHED' }, 'FUNDED');

    await svc.getOrder('order-1', USER_ADDR);

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'order-1' }, data: { status: 'FUNDED' } }),
    );
  });

  it('leaves the row alone when the chain is behind the database', async () => {
    const { svc, prisma } = makeSvc({ status: 'FIAT_PAID' }, 'FUNDED');

    await svc.getOrder('order-1', USER_ADDR);

    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('leaves the row alone when the chain cannot be read, rather than downgrading it', async () => {
    const { svc, prisma, stellar } = makeSvc({ status: 'FUNDED' }, null);

    const serialized = await svc.getOrder('order-1', USER_ADDR);

    expect(stellar.getTradeStatus).toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(serialized.status).toBe('FUNDED');
  });

  it('does not read the chain at all for a status that is never refreshed from it', async () => {
    const { svc, stellar, prisma } = makeSvc({ status: 'RELEASED' }, 'REFUNDED');

    await svc.getOrder('order-1', USER_ADDR);

    expect(stellar.getTradeStatus).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('resolves the contract to read from the order row, not the configured default', async () => {
    const { svc, stellar } = makeSvc({ status: 'MATCHED', contractId: 'CRETIRED' }, 'FUNDED');

    await svc.getOrder('order-1', USER_ADDR);

    expect(stellar.getTradeStatus).toHaveBeenCalledWith('CRETIRED', TRADE_ID);
  });

  it('falls back to the configured escrow when the order carries no contract of its own', async () => {
    const { svc, stellar } = makeSvc({ status: 'MATCHED', contractId: null }, 'FUNDED');

    await svc.getOrder('order-1', USER_ADDR);

    expect(stellar.getTradeStatus).toHaveBeenCalledWith(CONTRACT, TRADE_ID);
  });
});
