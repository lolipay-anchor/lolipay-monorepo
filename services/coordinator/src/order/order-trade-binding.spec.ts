import { Logger } from '@nestjs/common';
import { OrderService } from './order.service';
import { makeUserReputationStub, onChainTradeFor } from './test-helpers';

const fakeStorage = {} as any;

describe('OrderService — an on-chain trade must bind to the order before it counts (X0)', () => {
  const USER_ADDR = 'GUSER';
  const LP_ADDR = 'GLP';
  const ATTACKER = 'GATTACKER';
  const PLATFORM = 'GPLATFORM';
  const CONTRACT = 'CESCROW';
  const FAKE_TRADE_ID = 'a'.repeat(64);

  function makeOrder(overrides: Partial<any> = {}): any {
    return {
      id: 'order-1',
      tradeId: FAKE_TRADE_ID,
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
      payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
      lp: { id: 'lp-1', stellarAddress: LP_ADDR, approvedAt: new Date(), createdAt: new Date(), online: true },
      ...overrides,
    };
  }

  function makeSvc(orderOverrides: Partial<any> = {}, stellarOverrides: any = {}) {
    const order = makeOrder(orderOverrides);
    const prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(order),
        update: jest.fn().mockImplementation(async ({ data }: any) => ({ ...order, ...data })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([order]),
      },
      quote: {},
      config: { upsert: jest.fn().mockResolvedValue({ postSettleDisputeWindowSecs: 3600, requireProof: true }) },
      lp: { findUnique: jest.fn().mockResolvedValue({ id: 'lp-1', stellarAddress: LP_ADDR }) },
    } as any;

    const stellar = {
      getTradeStatus: jest.fn().mockResolvedValue(null),
      getTradeStatusStrict: jest.fn().mockResolvedValue(null),
      ...stellarOverrides,
    } as any;

    const matching = { pickLp: jest.fn() } as any;
    const cfg = { platformWallet: PLATFORM, escrowContractId: CONTRACT } as any;
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
    );
    return { svc, prisma, stellar, order };
  }

  const underfunded = (order: any) => onChainTradeFor(order, 'FUNDED', { usdcAmount: 1n });

  describe('cancelOrder', () => {
    it('does not let an unbound trade promote the order out of a cancellable state', async () => {
      const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { svc, prisma, order } = makeSvc(
        {},
        { getTradeStatusStrict: jest.fn().mockImplementation(async () => underfunded(makeOrder())) },
      );

      await svc.cancelOrder('order-1', USER_ADDR);

      expect(prisma.order.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'CANCELLED' } }),
      );
      expect(prisma.order.update).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('REFUSING to bind'));
      errSpy.mockRestore();
      void order;
    });

    it('still refuses the cancel when the on-chain trade genuinely binds and is funded', async () => {
      const { svc, prisma } = makeSvc(
        {},
        {
          getTradeStatusStrict: jest
            .fn()
            .mockImplementation(async () => onChainTradeFor(makeOrder(), 'FUNDED')),
        },
      );

      await expect(svc.cancelOrder('order-1', USER_ADDR)).rejects.toThrow(
        'cannot cancel order at this stage',
      );
      expect(prisma.order.update).toHaveBeenCalled();
    });
  });

  describe('getOrder', () => {
    it('does not promote to FUNDED and does not reveal payment instructions for an unbound trade', async () => {
      const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { svc, prisma } = makeSvc(
        {},
        { getTradeStatus: jest.fn().mockImplementation(async () => underfunded(makeOrder())) },
      );

      const result = await svc.getOrder('order-1', USER_ADDR);

      expect(result.status).toBe('MATCHED');
      expect(result.payment_instructions).toBeUndefined();
      expect(prisma.order.update).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('promotes and reveals to the fiat payer when the trade genuinely binds', async () => {
      const { svc } = makeSvc(
        {},
        {
          getTradeStatus: jest
            .fn()
            .mockImplementation(async () => onChainTradeFor(makeOrder(), 'FUNDED')),
        },
      );

      const result = await svc.getOrder('order-1', USER_ADDR);

      expect(result.status).toBe('FUNDED');
      expect(result.payment_instructions).toBeDefined();
    });

    it('refuses a trade whose recipient was redirected to a third party', async () => {
      const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { svc } = makeSvc(
        {},
        {
          getTradeStatus: jest
            .fn()
            .mockImplementation(async () =>
              onChainTradeFor(makeOrder(), 'FUNDED', { usdcRecipient: ATTACKER }),
            ),
        },
      );

      const result = await svc.getOrder('order-1', USER_ADDR);

      expect(result.status).toBe('MATCHED');
      expect(result.payment_instructions).toBeUndefined();
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('usdcRecipient'));
      errSpy.mockRestore();
    });
  });

  describe('listLpAssignments', () => {
    it('does not promote an assignment whose on-chain trade does not bind', async () => {
      const errSpy = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      const { svc, prisma } = makeSvc(
        {},
        { getTradeStatus: jest.fn().mockImplementation(async () => underfunded(makeOrder())) },
      );

      const rows = await svc.listLpAssignments(LP_ADDR);

      expect(rows[0].order.status).toBe('MATCHED');
      expect(rows[0].order.payment_instructions).toBeUndefined();
      expect(prisma.order.update).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });
  });

  it('does not re-verify an order that is already bound on chain', async () => {
    const getTradeStatus = jest
      .fn()
      .mockImplementation(async () => onChainTradeFor(makeOrder(), 'FIAT_PAID'));
    const { svc } = makeSvc({ status: 'FUNDED' }, { getTradeStatus });

    const result = await svc.getOrder('order-1', USER_ADDR);

    expect(result.status).toBe('FIAT_PAID');
  });
});
