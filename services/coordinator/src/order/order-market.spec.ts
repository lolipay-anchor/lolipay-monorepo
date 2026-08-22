import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { makeUserReputationStub, withTxSupport, orderStatusFor, orderTxFor } from './test-helpers';

const fakeStorage = {} as any;

describe('OrderService.createFromQuote — market-aware order creation (Phase 4 Task 6)', () => {
  const USER = 'GUSER';
  const LP = 'GLP';
  const PLATFORM = 'GPLATFORM';

  function makeQuote(overrides: Partial<any> = {}) {
    return {
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
      ...overrides,
    };
  }

  function makeSvc(quoteOverrides: Partial<any> = {}, marketsOverrides: any = {}) {
    const quote = makeQuote(quoteOverrides);
    const prisma = {
      quote: {
        findUnique: jest.fn().mockResolvedValue(quote),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        create: jest.fn().mockImplementation(({ data }: any) =>
          Promise.resolve({
            id: 'ord-1',
            tradeId: 't1',
            lpId: 'lp1',
            platformWallet: PLATFORM,
            lpWallet: LP,
            status: 'MATCHED',
            payDeadline: BigInt(0),
            confirmDeadline: BigInt(0),
            disputeDeadline: BigInt(0),
            expiresAt: new Date(),
            createdAt: new Date(),
            ...data,
          }),
        ),
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
    const stellar = { hasUsdcTrustline: jest.fn().mockResolvedValue(true) } as any;
    const matching = {
      pickLp: jest
        .fn()
        .mockResolvedValue({ id: 'lp1', stellarAddress: LP, paymentMethodId: 'pm1', details: 'BCA 123' }),
    } as any;
    const cfg = { platformWallet: PLATFORM } as any;
    const markets = {
      getEnabled: jest.fn().mockResolvedValue({ code: quote.fiatCurrency, enabled: true }),
      ...marketsOverrides,
    } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new OrderService(prisma, stellar, matching, cfg, markets, notifications, fakeStorage, makeUserReputationStub(), orderStatusFor(prisma, stellar, cfg), orderTxFor(prisma, stellar, cfg));
    return { svc, prisma, stellar, matching, markets };
  }

  it('persists fiatCurrency explicitly from the quote onto the Order row', async () => {
    const { svc, prisma } = makeSvc({ fiatCurrency: 'IDR' });
    await svc.createFromQuote(USER, 'q1');

    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fiatCurrency: 'IDR' }) }),
    );
  });

  it('re-validates the quote fiat is still enabled via MarketsService.getEnabled', async () => {
    const { svc, markets } = makeSvc({ fiatCurrency: 'IDR' });
    await svc.createFromQuote(USER, 'q1');

    expect(markets.getEnabled).toHaveBeenCalledWith('IDR');
  });

  it('passes the quote fiat through to matching.pickLp(rail, fiat)', async () => {
    const { svc, matching } = makeSvc({ fiatCurrency: 'IDR', rail: 'BANK' });
    await svc.createFromQuote(USER, 'q1');

    expect(matching.pickLp).toHaveBeenCalledWith('BANK', 'IDR');
  });

  it(
    'fails closed with 400 when the quote fiat was disabled after the quote was created — ' +
      'no matching, no trustline checks, no quote consumption, no order write',
    async () => {
      const { svc, prisma, matching, stellar } = makeSvc(
        { fiatCurrency: 'PHP' },
        { getEnabled: jest.fn().mockRejectedValue(new BadRequestException('market not enabled: PHP')) },
      );

      await expect(svc.createFromQuote(USER, 'q1')).rejects.toBeInstanceOf(BadRequestException);
      expect(matching.pickLp).not.toHaveBeenCalled();
      expect(stellar.hasUsdcTrustline).not.toHaveBeenCalled();
      expect(prisma.quote.updateMany).not.toHaveBeenCalled();
      expect(prisma.order.create).not.toHaveBeenCalled();
    },
  );
});
