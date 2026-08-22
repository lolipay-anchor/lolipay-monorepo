import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderService } from './order.service';
import { orderStatusFor, orderTxFor } from './test-helpers';

describe('OrderService.createFromQuote — advisory-lock transaction wiring (SECURITY MEDIUM fix wave)', () => {
  const USER = 'GUSER';
  const LP = 'GLP';
  const PLATFORM = 'GPLATFORM';

  function makeQuote(overrides: Record<string, any> = {}) {
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

  function makeConfigRow() {
    return {
      id: 1,
      paused: false,
      minOrder: 1n,
      maxOrder: 10_000_000_000n,
      platformWallet: PLATFORM,
      payWindowSecs: 1800,
      confirmWindowSecs: 1800,
      disputeWindowSecs: 1800,
    };
  }

  function makeSvc(opts: {
    quoteOverrides?: Record<string, any>;
    usedInsideTx?: bigint;
    limitBase?: bigint;
    quoteConsumeCount?: number;
  } = {}) {
    const quote = makeQuote(opts.quoteOverrides);
    const limitBase = opts.limitBase ?? 1_000_000_000n;

    const txQuote = { updateMany: jest.fn().mockResolvedValue({ count: opts.quoteConsumeCount ?? 1 }) };
    const txOrder = {
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({
          id: 'ord-1',
          status: data.status,
          payDeadline: BigInt(0),
          confirmDeadline: BigInt(0),
          disputeDeadline: BigInt(0),
          expiresAt: new Date(),
          createdAt: new Date(),
          ...data,
        }),
      ),
    };
    const txExecuteRaw = jest.fn().mockResolvedValue(0);

    const tx = { quote: txQuote, order: txOrder, $executeRaw: txExecuteRaw };

    const transactionSpy = jest.fn((cb: (tx: any) => unknown) => cb(tx));

    const prisma = {
      quote: {
        findUnique: jest.fn().mockResolvedValue(quote),

        updateMany: jest.fn().mockRejectedValue(new Error('quote.updateMany called OUTSIDE the transaction')),
      },
      order: {
        create: jest.fn().mockRejectedValue(new Error('order.create called OUTSIDE the transaction')),
      },
      config: { upsert: jest.fn().mockResolvedValue(makeConfigRow()) },
      $transaction: transactionSpy,

      $executeRaw: jest.fn().mockRejectedValue(new Error('$executeRaw called OUTSIDE the transaction')),
    } as any;

    const usedInsideTx = opts.usedInsideTx ?? 0n;
    const userReputation = {
      getReputation: jest.fn().mockResolvedValue({ tier: 'BRONZE', completedTrades: 0, disputesLost: 0, completionRate: null }),
      dailyLimitBaseUnits: jest.fn().mockReturnValue(limitBase),

      used24hBaseUnits: jest.fn((_addr: string, client?: any) =>
        Promise.resolve(client === tx ? usedInsideTx : 0n),
      ),
    } as any;

    const stellar = { hasUsdcTrustline: jest.fn().mockResolvedValue(true) } as any;
    const matching = {
      pickLp: jest.fn().mockResolvedValue({ id: 'lp1', stellarAddress: LP, paymentMethodId: 'pm1', details: 'BCA 123' }),
    } as any;
    const cfg = { platformWallet: PLATFORM } as any;
    const markets = { getEnabled: jest.fn().mockResolvedValue({ code: 'IDR', enabled: true }) } as any;
    const notifications = { notifyOrderStatus: jest.fn().mockResolvedValue(undefined) } as any;
    const storage = {} as any;

    const svc = new OrderService(prisma, stellar, matching, cfg, markets, notifications, storage, userReputation, orderStatusFor(prisma, stellar, cfg), orderTxFor(prisma, stellar, cfg));
    return { svc, prisma, tx, txQuote, txOrder, txExecuteRaw, transactionSpy, userReputation };
  }

  it('TOP_UP/WITHDRAW path: wraps the critical section in prisma.$transaction exactly once', async () => {
    const { svc, transactionSpy } = makeSvc();
    await svc.createFromQuote(USER, 'q1', 'bank details');
    expect(transactionSpy).toHaveBeenCalledTimes(1);
  });

  it('takes a per-user Postgres advisory xact lock via tx.$executeRaw(pg_advisory_xact_lock(hashtext(...)))', async () => {
    const { svc, txExecuteRaw } = makeSvc();
    await svc.createFromQuote(USER, 'q1', 'bank details');

    expect(txExecuteRaw).toHaveBeenCalledTimes(1);
    const [strings, ...values] = txExecuteRaw.mock.calls[0];
    const sql = strings.join('?');
    expect(sql).toContain('pg_advisory_xact_lock');
    expect(sql).toContain('hashtext');
    expect(values).toContain(USER);
  });

  it('never takes the advisory lock (or touches quote/order) on the OUTSIDE-of-tx prisma client', async () => {
    const { svc, prisma } = makeSvc();
    await svc.createFromQuote(USER, 'q1', 'bank details');

    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(prisma.quote.updateMany).not.toHaveBeenCalled();
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it('re-reads used24h using the tx client (not this.prisma) as the authoritative check', async () => {
    const { svc, userReputation, tx } = makeSvc({ usedInsideTx: 0n });
    await svc.createFromQuote(USER, 'q1', 'bank details');

    expect(userReputation.used24hBaseUnits).toHaveBeenCalledWith(USER, tx);
  });

  it('rejects (rolling back the transaction) when the in-tx re-read shows the limit is now exceeded — even though the outer advisory pre-check passed', async () => {
    const { svc, txQuote, txOrder } = makeSvc({
      quoteOverrides: { usdcAmount: 1_000_000_000n },
      usedInsideTx: 500_000_000n,
      limitBase: 1_000_000_000n,
    });

    await expect(svc.createFromQuote(USER, 'q1', 'bank details')).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.createFromQuote(USER, 'q1', 'bank details')).rejects.toThrow('daily limit exceeded');

    expect(txQuote.updateMany).not.toHaveBeenCalled();
    expect(txOrder.create).not.toHaveBeenCalled();
  });

  it('quote-consume race lost inside the SAME transaction still surfaces as 409, after the lock was already taken', async () => {
    const { svc, txExecuteRaw } = makeSvc({ quoteConsumeCount: 0 });
    await expect(svc.createFromQuote(USER, 'q1', 'bank details')).rejects.toBeInstanceOf(ConflictException);

    expect(txExecuteRaw).toHaveBeenCalledTimes(1);
  });

  it('happy path still creates the order via the tx client end-to-end', async () => {
    const { svc, txOrder, txQuote } = makeSvc();
    const result = await svc.createFromQuote(USER, 'q1', 'bank details');
    expect(result.order).toBeTruthy();
    expect(txQuote.updateMany).toHaveBeenCalledWith({ where: { id: 'q1', usedAt: null }, data: expect.any(Object) });
    expect(txOrder.create).toHaveBeenCalledTimes(1);
  });
});
