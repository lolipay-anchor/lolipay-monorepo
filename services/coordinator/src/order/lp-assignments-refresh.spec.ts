import { OrderService } from './order.service';
import { makeUserReputationStub, onChainTradeFor, orderStatusFor, orderTxFor, verifiedCustomerStub } from './test-helpers';

const fakeStorage = {} as any;
const USER_ADDR = 'GUSER';
const LP_ADDR = 'GLP';
const PLATFORM = 'GPLATFORM';
const CONTRACT = 'CORDER_SNAPSHOT';
const FAKE_TRADE_ID = 'a'.repeat(64);

function makeOrder(overrides: Partial<any> = {}): any {
  return {
    id: 'order-1',
    tradeId: FAKE_TRADE_ID,
    contractId: CONTRACT,
    userAddress: USER_ADDR,
    personId: 'person-test',
    flow: 'TOP_UP',
    status: 'FIAT_PAID',
    fiatCurrency: 'IDR',
    usdcAmount: BigInt('100000000'),
    fiatAmount: BigInt('1600000'),
    platformFeeBps: 30,
    lpFeeBps: 120,
    platformWallet: PLATFORM,
    lpWallet: LP_ADDR,
    lpId: 'lp-1',
    lpPaymentDetails: 'BCA 1234567890 a/n Provider',
    payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
    confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
    ...overrides,
  };
}

function build() {
  const order = makeOrder();
  const prisma = {
    kycVerification: verifiedCustomerStub(),
    order: {
      findUnique: jest.fn().mockResolvedValue(order),
      update: jest.fn().mockResolvedValue(order),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([order]),
    },
    quote: {},
    config: { upsert: jest.fn() },
    lp: { findUnique: jest.fn().mockResolvedValue({ id: 'lp-1', stellarAddress: LP_ADDR }) },
  } as any;
  const stellar = {
    getStakeInfo: jest.fn(),
    getTradeStatus: jest.fn().mockResolvedValue(onChainTradeFor(order, 'RELEASED')),
    getTradeStatusStrict: jest.fn().mockResolvedValue(onChainTradeFor(order, 'RELEASED')),
  } as any;
  const cfg = { platformWallet: PLATFORM, escrowContractId: CONTRACT } as any;
  const status = orderStatusFor(prisma, stellar, cfg);
  const svc = new OrderService(
    prisma,
    stellar,
    { pickLp: jest.fn() } as any,
    cfg,
    { getEnabled: jest.fn() } as any,
    { notifyOrderStatus: jest.fn() } as any,
    fakeStorage,
    makeUserReputationStub(),
    status,
    orderTxFor(prisma, stellar, cfg),
  );
  return { svc, prisma, status, order };
}

describe('the provider assignment list refreshes from chain through one writer', () => {
  it('refreshes an assignment through the shared guarded writer, never through its own bare update', async () => {
    const { svc, prisma, status } = build();
    const refresh = jest
      .spyOn(status, 'refreshOrderStatus')
      .mockResolvedValue(makeOrder({ status: 'RELEASED' }));

    await svc.listLpAssignments(LP_ADDR);

    expect(refresh).toHaveBeenCalledWith('order-1', expect.objectContaining({ id: 'order-1' }));
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('serves the refreshed row, so the provider sees the status the chain reports', async () => {
    const { svc, status } = build();
    jest.spyOn(status, 'refreshOrderStatus').mockResolvedValue(makeOrder({ status: 'RELEASED' }));

    const rows = await svc.listLpAssignments(LP_ADDR);

    expect(rows).toHaveLength(1);
    expect(rows[0].order.status).toBe('RELEASED');
  });
});
