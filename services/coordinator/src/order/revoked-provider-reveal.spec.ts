import { OrderService } from './order.service';
import {
  makeUserReputationStub,
  onChainTradeFor,
  orderStatusFor,
  orderTxFor,
  verifiedCustomerStub,
} from './test-helpers';

const USER_ADDR = 'GUSER';
const LP_ADDR = 'GLP';
const PLATFORM = 'GPLATFORM';
const CONTRACT = 'CREVOKEDPROVIDER';
const FAKE_TRADE_ID = 'b'.repeat(64);
const USER_BANK = 'BCA 1234567890 a/n Depositor';
const LP_BANK = 'BNI 9876543210 a/n Provider';

function lpRow(status: string) {
  return {
    id: 'lp-1',
    stellarAddress: LP_ADDR,
    status,
    online: true,
    approvedAt: new Date(0),
    createdAt: new Date(0),
    disputesLost: 0,
  };
}

function makeOrder(lpStatus: string, overrides: Partial<any> = {}): any {
  return {
    id: 'order-1',
    tradeId: FAKE_TRADE_ID,
    contractId: CONTRACT,
    userAddress: USER_ADDR,
    personId: 'person-test',
    flow: 'WITHDRAW',
    status: 'FUNDED',
    fiatCurrency: 'IDR',
    usdcAmount: BigInt('100000000'),
    fiatAmount: BigInt('1600000'),
    platformFeeBps: 30,
    lpFeeBps: 120,
    platformWallet: PLATFORM,
    lpWallet: LP_ADDR,
    lpId: 'lp-1',
    userPaymentDetails: USER_BANK,
    lpPaymentDetails: LP_BANK,
    payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
    confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
    lp: lpRow(lpStatus),
    ...overrides,
  };
}

function build(order: any, refreshedOrder: any = order) {
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
    config: { upsert: jest.fn().mockResolvedValue({ platformWallet: PLATFORM, requireProof: false }) },
    lp: { findUnique: jest.fn().mockResolvedValue(order.lp) },
  } as any;
  const stellar = {
    getStakeInfo: jest.fn().mockResolvedValue(null),
    getTradeStatus: jest.fn().mockResolvedValue(onChainTradeFor(order, order.status)),
    getTradeStatusStrict: jest.fn().mockResolvedValue(onChainTradeFor(order, order.status)),
  } as any;
  const cfg = {
    platformWallet: PLATFORM,
    escrowContractId: CONTRACT,
    kycRequireAml: true,
    adminAddresses: [],
  } as any;
  const status = orderStatusFor(prisma, stellar, cfg);
  jest.spyOn(status, 'refreshOrderStatus').mockResolvedValue(refreshedOrder);
  const svc = new OrderService(
    prisma,
    stellar,
    { pickLp: jest.fn() } as any,
    cfg,
    { getEnabled: jest.fn() } as any,
    { notifyOrderStatus: jest.fn() } as any,
    {} as any,
    makeUserReputationStub(),
    status,
    orderTxFor(prisma, stellar, cfg),
  );
  return { svc, prisma };
}

describe('a provider whose approval was withdrawn stops receiving the counterparty bank account', () => {
  it('withholds the payment instructions from a REVOKED provider on a funded withdrawal', async () => {
    const { svc } = build(makeOrder('REVOKED'));

    const serialized = await svc.getOrder('order-1', LP_ADDR);

    expect(serialized.payment_instructions).toBeUndefined();
    expect(JSON.stringify(serialized)).not.toContain(USER_BANK);
  });

  it('withholds the payment instructions from a SUSPENDED provider on a funded withdrawal', async () => {
    const { svc } = build(makeOrder('SUSPENDED'));

    const serialized = await svc.getOrder('order-1', LP_ADDR);

    expect(serialized.payment_instructions).toBeUndefined();
  });

  it('still hands the payment instructions to an APPROVED provider, so the withdrawal can be paid', async () => {
    const { svc } = build(makeOrder('APPROVED'));

    const serialized = await svc.getOrder('order-1', LP_ADDR);

    expect(serialized.payment_instructions).toBe(USER_BANK);
  });

  it('still lets a REVOKED provider read the order itself, so an open dispute stays arguable', async () => {
    const { svc } = build(makeOrder('REVOKED'));

    const serialized = await svc.getOrder('order-1', LP_ADDR);

    expect(serialized.id).toBe('order-1');
    expect(serialized.status).toBe('FUNDED');
  });

  it('leaves the depositor their own instructions on a top-up even when the provider is REVOKED', async () => {
    const order = makeOrder('REVOKED', { flow: 'TOP_UP' });
    const { svc } = build(order);

    const serialized = await svc.getOrder('order-1', USER_ADDR);

    expect(serialized.payment_instructions).toBe(LP_BANK);
  });

  it('withholds the payment instructions from a REVOKED provider on the assignment list too', async () => {
    const { svc } = build(makeOrder('REVOKED'));

    const rows = await svc.listLpAssignments(LP_ADDR);

    expect(rows).toHaveLength(1);
    expect(rows[0].order.payment_instructions).toBeUndefined();
    expect(JSON.stringify(rows[0])).not.toContain(USER_BANK);
  });

  it('still lists the payment instructions for an APPROVED provider on the assignment list', async () => {
    const { svc } = build(makeOrder('APPROVED'));

    const rows = await svc.listLpAssignments(LP_ADDR);

    expect(rows).toHaveLength(1);
    expect(rows[0].order.payment_instructions).toBe(USER_BANK);
  });
});

describe('the reveal reads the provider row the refresh returned, not the one the request opened with', () => {
  it('withholds the bank account when the approval was withdrawn while the order was refreshing from chain', async () => {
    const opened = makeOrder('APPROVED');
    const refreshed = { ...opened, lp: lpRow('REVOKED') };
    const { svc } = build(opened, refreshed);

    const serialized = await svc.getOrder('order-1', LP_ADDR);

    expect(serialized.payment_instructions).toBeUndefined();
    expect(JSON.stringify(serialized)).not.toContain(USER_BANK);
  });

  it('hands over the bank account when the approval was restored while the order was refreshing from chain', async () => {
    const opened = makeOrder('REVOKED');
    const refreshed = { ...opened, lp: lpRow('APPROVED') };
    const { svc } = build(opened, refreshed);

    const serialized = await svc.getOrder('order-1', LP_ADDR);

    expect(serialized.payment_instructions).toBe(USER_BANK);
  });
});
