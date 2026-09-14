import { BadRequestException, Logger } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { OrderService } from './order.service';
import { makeUserReputationStub, withTxSupport, orderStatusFor, orderTxFor, verifiedCustomerStub } from './test-helpers';

const fakeStorage = {} as any;

const USER = 'GUSER';
const LP = 'GLP';
const PLATFORM = 'GPLATFORM';

describe('OrderService.createFromQuote — the matched provider is told, instead of being expected to watch a screen', () => {
  function makeSvc(quoteOverrides: Partial<any> = {}) {
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
      ...quoteOverrides,
    };
    const created: any[] = [];
    const prisma = {
      quote: {
        findUnique: jest.fn().mockResolvedValue(quote),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      order: {
        create: jest.fn().mockImplementation(({ data }: any) => {
          const row = {
            id: `ord-${created.length + 1}`,
            tradeId: 't1',
            lpId: 'lp1',
            platformWallet: PLATFORM,
            lpWallet: LP,
            createdAt: new Date(),
            ...data,
          };
          created.push(row);
          return Promise.resolve(row);
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
    prisma.kycVerification = verifiedCustomerStub();
    withTxSupport(prisma);
    const stellar = {
      getStakeInfo: jest.fn().mockResolvedValue({ staked: '1000000000000', unbonding: '0', unbond_available_at: 0, min_stake: '1', eligible: true }),
      hasUsdcTrustline: jest.fn().mockResolvedValue(true),
    } as any;
    const matching = {
      pickLp: jest.fn().mockResolvedValue({ id: 'lp1', stellarAddress: LP, paymentMethodId: 'pm1', details: 'BCA 123' }),
    } as any;
    const cfg = { platformWallet: PLATFORM } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: quote.fiatCurrency, enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const svc = new OrderService(prisma, stellar, matching, cfg, markets, notifications, fakeStorage, makeUserReputationStub(), orderStatusFor(prisma, stellar, cfg), orderTxFor(prisma, stellar, cfg));
    return { svc, prisma, notifications, markets, created };
  }

  it('tells the provider the order is theirs, handing over the row that was written and the MATCHED status', async () => {
    const { svc, notifications, created } = makeSvc();

    await svc.createFromQuote(USER, 'q1');

    expect(notifications.notifyOrderStatus).toHaveBeenCalledTimes(1);
    expect(notifications.notifyOrderStatus.mock.calls[0][0]).toBe(created[0]);
    expect(notifications.notifyOrderStatus.mock.calls[0][1]).toBe('MATCHED');
  });

  it('hands over the pay deadline, which is what the message turns into the time the provider has', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(1_700_000_000_000));
    try {
      const { svc, notifications } = makeSvc();

      await svc.createFromQuote(USER, 'q1');

      const handed = notifications.notifyOrderStatus.mock.calls[0][0];
      expect(typeof handed.payDeadline).toBe('bigint');
      expect(handed.payDeadline).toBe(1_700_001_800n);
    } finally {
      jest.useRealTimers();
    }
  });

  it('tells the provider only after the order is committed, never from inside the transaction that writes it', async () => {
    const { svc, prisma, notifications } = makeSvc();
    const toldByTheTimeTheTransactionClosed: number[] = [];
    prisma.$transaction = jest.fn(async (cb: any) => {
      const out = await cb(prisma);
      toldByTheTimeTheTransactionClosed.push(notifications.notifyOrderStatus.mock.calls.length);
      return out;
    });

    await svc.createFromQuote(USER, 'q1');

    expect(toldByTheTimeTheTransactionClosed).toEqual([0]);
    expect(notifications.notifyOrderStatus).toHaveBeenCalledTimes(1);
  });

  it('still returns the order when the provider could not be told, because the row and the quote already moved', async () => {
    const { svc, notifications } = makeSvc();
    const told = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    notifications.notifyOrderStatus.mockRejectedValue(new Error('outbox down'));

    await expect(svc.createFromQuote(USER, 'q1')).resolves.toMatchObject({
      order: expect.objectContaining({ id: 'ord-1' }),
    });
    expect(told).toHaveBeenCalledWith(expect.stringMatching(/ord-1.*not told/));
    told.mockRestore();
  });

  it('tells the provider once, not once per attempt, when a transfer-reference collision forces a retry', async () => {
    const { svc, prisma, notifications } = makeSvc();
    const collision = new Prisma.PrismaClientKnownRequestError('ref taken', {
      code: 'P2002',
      clientVersion: 'test',
    });
    (prisma.order.create as jest.Mock).mockRejectedValueOnce(collision);

    await svc.createFromQuote(USER, 'q1');

    expect(prisma.order.create).toHaveBeenCalledTimes(2);
    expect(notifications.notifyOrderStatus).toHaveBeenCalledTimes(1);
  });

  it('tells nobody when no order was created', async () => {
    const { svc, notifications, markets } = makeSvc();
    markets.getEnabled.mockRejectedValue(new BadRequestException('market not enabled: IDR'));

    await expect(svc.createFromQuote(USER, 'q1')).rejects.toBeInstanceOf(BadRequestException);
    expect(notifications.notifyOrderStatus).not.toHaveBeenCalled();
  });
});
