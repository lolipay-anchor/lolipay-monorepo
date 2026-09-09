import { Sep24Service } from './sep24.service';
import { mintInteractiveToken } from './interactive-token';

describe('a deposit that loses the race is cancelled, not abandoned', () => {
  function build(linkedCount: number, alreadyLinked: string | null = null) {
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
          order: null,
        })),
        updateMany: jest.fn(async () => ({ count: linkedCount })),
      },
      kycVerification: {
        findUnique: jest.fn(async () => ({ status: 'ACCEPTED', screenedAt: new Date() })),
        findFirst: jest.fn(async (args: any) =>
          args.where.status === 'ACCEPTED' ? { customerRef: 'GABC' } : null,
        ),
      },
      order: { updateMany: jest.fn(async (args: any) => (updates.push(args), { count: 1 })) },
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

    return { svc, updates, quotes, token: mintInteractiveToken(cfg, 'tx-1', 'GABC') };
  }

  it('cancels the order it could not bind, so provider capacity is freed at once', async () => {
    const { svc, updates, token } = build(0);

    await svc.submitAmount('tx-1', token, '400000');

    expect(updates).toHaveLength(1);
    expect(updates[0].where.id).toBe('order-2');
    expect(updates[0].data.status).toBe('CANCELLED');
    expect(updates[0].where.status.in).toEqual(expect.arrayContaining(['CREATED', 'MATCHED']));
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
});
