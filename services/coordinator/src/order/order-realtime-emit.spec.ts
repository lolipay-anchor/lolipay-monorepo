import { OrderService } from './order.service';
import { makeUserReputationStub, onChainTradeFor, orderStatusFor, orderTxFor, verifiedCustomerStub } from './test-helpers';

const fakeStorage = {} as any;

describe('OrderStatusService.refreshOrderStatus — realtime emit on chain-confirmed advance', () => {
  const USER_ADDR = 'GUSER';
  const LP_ADDR = 'GLP';
  const PLATFORM = 'GPLATFORM';

  function makeOrder(overrides: Partial<any> = {}): any {
    return {
      id: 'order-1',
      tradeId: 'a'.repeat(64),
      contractId: 'CTEST',
      userAddress: USER_ADDR,
      flow: 'TOP_UP',
      status: 'MATCHED',
      fiatCurrency: 'IDR',
      usdcAmount: BigInt('100000000'),
      fiatAmount: BigInt('1600000'),
      rateSnapshot: '16000',
      platformFeeBps: 30,
      lpFeeBps: 120,
      platformWallet: PLATFORM,
      lpWallet: LP_ADDR,
      lpId: 'lp-1',
      lp: {
        id: 'lp-1',
        stellarAddress: LP_ADDR,
        online: true,
        approvedAt: new Date('2026-01-01T00:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
      rail: 'BANK',
      expiresAt: new Date(),
      createdAt: new Date(),
      ...overrides,
    };
  }

  function makeSvc(onChainStatus: string | null, orderOverrides: Partial<any> = {}) {
    const order = makeOrder(orderOverrides);
    const updated = { ...order, status: onChainStatus ?? order.status };
    const prisma = {
      kycVerification: verifiedCustomerStub(),
      order: {
        findUnique: jest.fn().mockResolvedValue({ ...order }),
        update: jest.fn().mockResolvedValue(updated),
        count: jest.fn().mockResolvedValue(0),
      },
      config: { upsert: jest.fn(), findUnique: jest.fn().mockResolvedValue(null) },
      lp: { findUnique: jest.fn() },
    } as any;
    const stellar = {
      getTradeStatus: jest
        .fn()
        .mockResolvedValue(onChainStatus ? onChainTradeFor(order, onChainStatus) : null),
    } as any;
    const matching = { pickLp: jest.fn() } as any;
    const cfg = { platformWallet: PLATFORM, escrowContractId: 'CENV' } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const realtime = { emitOrderUpdate: jest.fn() } as any;

    const svc = new OrderService(
      prisma,
      stellar,
      matching,
      cfg,
      markets,
      notifications,
      fakeStorage,
      makeUserReputationStub(),
      orderStatusFor(prisma, stellar, cfg, realtime), orderTxFor(prisma, stellar, cfg, realtime),
    );
    return { svc, prisma, stellar, realtime, order };
  }

  it('emits order:update with the NEW status when get_trade confirms an isAhead advance', async () => {
    const { svc, realtime } = makeSvc('FUNDED');
    await svc.getOrder('order-1', USER_ADDR);

    expect(realtime.emitOrderUpdate).toHaveBeenCalledTimes(1);
    expect(realtime.emitOrderUpdate).toHaveBeenCalledWith({
      id: 'order-1',
      status: 'FUNDED',
      flow: 'TOP_UP',
      userAddress: USER_ADDR,
      lpWallet: LP_ADDR,
    });
  });

  it('does NOT emit when get_trade reports the SAME (non-ahead) status', async () => {
    const { svc, realtime, prisma } = makeSvc('MATCHED');
    await svc.getOrder('order-1', USER_ADDR);

    expect(realtime.emitOrderUpdate).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('does NOT emit when get_trade is unreachable (null)', async () => {
    const { svc, realtime } = makeSvc(null);
    await svc.getOrder('order-1', USER_ADDR);

    expect(realtime.emitOrderUpdate).not.toHaveBeenCalled();
  });

  it('never throws when realtime is omitted, since it is an optional dependency', async () => {
    const order = makeOrder();
    const prisma = {
      kycVerification: verifiedCustomerStub(),
      order: {
        findUnique: jest.fn().mockResolvedValue({ ...order }),
        update: jest.fn().mockResolvedValue({ ...order, status: 'FUNDED' }),
        count: jest.fn().mockResolvedValue(0),
      },
      config: { upsert: jest.fn(), findUnique: jest.fn().mockResolvedValue(null) },
      lp: { findUnique: jest.fn() },
    } as any;
    const stellar = { getTradeStatus: jest.fn().mockResolvedValue({ status: 'FUNDED' }) } as any;
    const matching = { pickLp: jest.fn() } as any;
    const cfg = { platformWallet: PLATFORM, escrowContractId: 'CENV' } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;

    const svc = new OrderService(
      prisma,
      stellar,
      matching,
      cfg,
      markets,
      notifications,
      fakeStorage,
      makeUserReputationStub(),
      orderStatusFor(prisma, stellar, cfg), orderTxFor(prisma, stellar, cfg),
    );

    await expect(svc.getOrder('order-1', USER_ADDR)).resolves.toBeTruthy();
  });
});
