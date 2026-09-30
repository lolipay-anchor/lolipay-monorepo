import { Logger, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Sep24Service } from './sep24.service';
import { mintInteractiveToken } from './interactive-token';

describe('a deposit that loses the race is cancelled, not abandoned', () => {
  function build(linkedCount: number, alreadyLinked: string | null = null, undoneCount = 1) {
    const updates: any[] = [];
    const quotes: any[] = [];
    const prisma: any = {
      sep24Transaction: {
        findUnique: jest.fn(async () => ({
          id: 'tx-1',
          stellarAccount: 'GABC',
          personId: 'person-1',
          orderId: alreadyLinked,
          startedAt: new Date(),
          flow: 'TOP_UP',
          order: alreadyLinked ? { status: 'CREATED' } : null,
        })),
        updateMany: jest.fn(async () => ({ count: linkedCount })),
      },
      kycVerification: {
        findUnique: jest.fn(async () => ({ status: 'ACCEPTED', screenedAt: new Date() })),
        findFirst: jest.fn(async (args: any) =>
          args.where.status === 'ACCEPTED' ? { customerRef: 'GABC' } : null,
        ),
      },
      order: { updateMany: jest.fn(async (args: any) => (updates.push(args), { count: undoneCount })) },
    };
    const cfg = {
      anchorBaseUrl: 'https://api.lolipay.app',
      usdcAssetCode: 'USDC',
      usdcAssetIssuer: 'GISSUER',
      jwtSecret: ['unit', 'test', 'key', '0123456789'].join('-'),
      jwtIssuer: 'https://lolipay.app',
      jwtAudience: 'lolipay-app',
    } as any;
    const rate = { createQuote: jest.fn(async () => (quotes.push(1), { id: 'quote-1' })) } as any;
    const orders = { createFromQuote: jest.fn(async () => ({ order: { id: 'order-2' } })) } as any;
    const people = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) } as any;
    const svc = new Sep24Service(prisma, cfg, {} as any, rate, orders, people, {} as any, {} as any, { isConfigured: false } as any);

    return { svc, updates, quotes, orders, prisma, token: mintInteractiveToken(cfg, 'tx-1', 'GABC') };
  }

  function captureLogs() {
    const warned: string[] = [];
    const errored: string[] = [];
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(((m: any) => {
      warned.push(String(m));
    }) as any);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(((m: any) => {
      errored.push(String(m));
    }) as any);
    return { warned, errored };
  }

  afterEach(() => jest.restoreAllMocks());

  it('cancels the loser only while it is exactly as createFromQuote left it, so a row anything else has touched is left alone', async () => {
    const { svc, updates, token } = build(0);

    await svc.submitAmount('tx-1', token, '400000');

    expect(updates).toHaveLength(1);
    expect(updates[0].where).toEqual({ id: 'order-2', status: 'MATCHED' });
    expect(updates[0].data).toEqual({ status: 'CANCELLED' });
  });

  it('does not refuse the person who lost it, because the winner already opened their order', async () => {
    const { svc, token } = build(0);

    await expect(svc.submitAmount('tx-1', token, '400000')).resolves.not.toThrow();
  });

  it('opens no second order at all when this transaction already has one', async () => {
    const { svc, updates, quotes, token } = build(1, 'order-1');

    await svc.submitAmount('tx-1', token, '400000');

    expect(quotes).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('cancels nothing when the binding succeeded', async () => {
    const { svc, updates, token } = build(1);

    await svc.submitAmount('tx-1', token, '400000');

    expect(updates).toHaveLength(0);
  });

  it('records the cancellation as a warning, naming the order it cancelled', async () => {
    const { warned, errored } = captureLogs();
    const { svc, token } = build(0, null, 1);

    await svc.submitAmount('tx-1', token, '400000');

    expect(errored).toHaveLength(0);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/has been cancelled/);
    expect(warned[0]).toContain('order-2');
  });

  it('raises the level to error, and says so, when the order it opened survived the cancel', async () => {
    const { warned, errored } = captureLogs();
    const { svc, token } = build(0, null, 0);

    await svc.submitAmount('tx-1', token, '400000');

    expect(warned).toHaveLength(0);
    expect(errored).toHaveLength(1);
    expect(errored[0]).toMatch(/could NOT be cancelled/);
    expect(errored[0]).toContain('order-2');
  });

  describe('a second press of Continue joins the first instead of opening a second order', () => {
    it('two presses inside the handler window mint one quote, open one order and cancel nothing', async () => {
      const { svc, updates, quotes, token, orders, prisma } = build(1);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      orders.createFromQuote.mockImplementation(async () => {
        await gate;
        return { order: { id: 'order-2' } };
      });
      prisma.sep24Transaction.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

      const first = svc.submitAmount('tx-1', token, '400000');
      const second = svc.submitAmount('tx-1', token, '400000');
      await new Promise((r) => setImmediate(r));
      release();
      await Promise.all([first, second]);

      expect(quotes).toHaveLength(1);
      expect(orders.createFromQuote).toHaveBeenCalledTimes(1);
      expect(prisma.sep24Transaction.updateMany).toHaveBeenCalledTimes(1);
      expect(updates).toHaveLength(0);
    });

    it('the second press sees the refusal the first press got, and the refusal was computed once', async () => {
      const { svc, quotes, token, orders } = build(1);
      const refused = new ServiceUnavailableException('no eligible LP available');
      let reject!: (e: unknown) => void;
      orders.createFromQuote.mockImplementation(() => new Promise<never>((_, r) => (reject = r)));

      const first = svc.submitAmount('tx-1', token, '400000');
      const second = svc.submitAmount('tx-1', token, '400000');
      await new Promise((r) => setImmediate(r));
      reject(refused);

      await expect(first).rejects.toBe(refused);
      await expect(second).rejects.toBe(refused);
      expect(orders.createFromQuote).toHaveBeenCalledTimes(1);
      expect(quotes).toHaveLength(1);
    });

    it('a press after a refusal is a fresh attempt, not a replay of the refusal', async () => {
      const { svc, token, orders } = build(1);
      orders.createFromQuote.mockRejectedValueOnce(new ServiceUnavailableException('no eligible LP available'));
      await expect(svc.submitAmount('tx-1', token, '400000')).rejects.toThrow();
      await expect(svc.submitAmount('tx-1', token, '400000')).resolves.toBeUndefined();
      expect(orders.createFromQuote).toHaveBeenCalledTimes(2);
    });

    it('a second press with a dead link does not ride on the first', async () => {
      const { svc, token, orders } = build(1);
      let release!: () => void;
      orders.createFromQuote.mockImplementation(
        () => new Promise((r) => (release = () => r({ order: { id: 'order-2' } }))),
      );
      const first = svc.submitAmount('tx-1', token, '400000');
      await new Promise((r) => setImmediate(r));
      await expect(svc.submitAmount('tx-1', 'not-a-token', '400000')).rejects.toBeInstanceOf(UnauthorizedException);
      release();
      await first;
      expect(orders.createFromQuote).toHaveBeenCalledTimes(1);
    });
  });
});
