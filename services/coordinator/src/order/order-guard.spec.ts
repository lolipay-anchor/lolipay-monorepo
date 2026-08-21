import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { makeUserReputationStub, withTxSupport } from './test-helpers';

const fakeStorage = {} as any;

describe('OrderService.createFromQuote — trustline guard', () => {
  const USER = 'GUSER';
  const LP = 'GLP';
  const PLATFORM = 'GPLATFORM';

  function makeSvc(hasTrustline: (addr: string) => boolean) {
    const quote = {
      id: 'q1',
      userAddress: USER,
      flow: 'TOP_UP',
      rail: 'BANK',
      usdcAmount: 100_000_000n,
      fiatAmount: 1_600_000n,
      fiatCurrency: 'IDR',
      rateSnapshot: '16000',
      platformFeeBps: 30,
      lpFeeBps: 120,
      usedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
    };
    const prisma = {
      quote: {
        findUnique: jest.fn().mockResolvedValue(quote),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        create: jest.fn().mockResolvedValue({
          id: 'ord-1',
          tradeId: 't1',
          userAddress: USER,
          lpId: 'lp1',
          flow: 'TOP_UP',
          rail: 'BANK',
          fiatCurrency: 'IDR',
          usdcAmount: 100_000_000n,
          fiatAmount: 1_600_000n,
          rateSnapshot: '16000',
          platformFeeBps: 30,
          lpFeeBps: 120,
          platformWallet: PLATFORM,
          lpWallet: LP,
          status: 'MATCHED',
          payDeadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
          confirmDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
          disputeDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
          expiresAt: new Date(Date.now() + 1_800_000),
          createdAt: new Date(),
          userPaymentDetails: null,
        }),
      },
      config: {
        upsert: jest.fn().mockResolvedValue({
          id: 1,
          paused: false,
          minOrder: 1n,
          maxOrder: 10_000_000_000n,
          platformWallet: PLATFORM,
          payWindowSecs: 1800,
          confirmWindowSecs: 1800,
          disputeWindowSecs: 1800,
        }),
      },
    } as any;
    withTxSupport(prisma);
    const stellar = { hasUsdcTrustline: jest.fn((a: string) => Promise.resolve(hasTrustline(a))) } as any;
    const matching = { pickLp: jest.fn().mockResolvedValue({ id: 'lp1', stellarAddress: LP, paymentMethodId: 'pm1', details: 'BCA 123' }) } as any;
    const cfg = { platformWallet: PLATFORM } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    return { svc: new OrderService(prisma, stellar, matching, cfg, markets, notifications, fakeStorage, makeUserReputationStub()), prisma };
  }

  it('rejects a TOP_UP order when the USER lacks a USDC trustline — and does NOT consume the quote', async () => {
    const { svc, prisma } = makeSvc((a) => a !== USER);
    await expect(svc.createFromQuote(USER, 'q1')).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.quote.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('creates the order (and consumes the quote) when all release recipients trust USDC', async () => {
    const { svc, prisma } = makeSvc(() => true);
    const order = await svc.createFromQuote(USER, 'q1');
    expect(order).toBeTruthy();
    expect(prisma.quote.updateMany).toHaveBeenCalled();
    expect(prisma.order.create).toHaveBeenCalled();
  });
});
