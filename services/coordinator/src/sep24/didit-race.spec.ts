import { Sep24Service } from './sep24.service';

describe('a deposit that loses the race is cancelled, not abandoned', () => {
  it('cancels the order it could not bind, so provider capacity is freed at once', async () => {
    const updates: any[] = [];
    const prisma: any = {
      sep24Transaction: {
        findUnique: jest.fn(async () => ({
          id: 'tx-1',
          stellarAccount: 'GABC',
          personId: 'person-1',
          orderId: null,
          startedAt: new Date(),
          flow: 'TOP_UP',
          order: null,
        })),
        updateMany: jest.fn(async () => ({ count: 0 })),
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
    const rate = { createQuote: jest.fn(async () => ({ id: 'quote-1' })) } as any;
    const orders = { createFromQuote: jest.fn(async () => ({ order: { id: 'order-2' } })) } as any;
    const people = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) } as any;
    const svc = new Sep24Service(prisma, cfg, {} as any, rate, orders, people, {} as any, {} as any, { isConfigured: false } as any);

    const { mintInteractiveToken } = await import('./interactive-token');
    const token = mintInteractiveToken(cfg, 'tx-1', 'GABC');

    await expect(svc.submitAmount('tx-1', token, '400000')).rejects.toThrow(/already opened/);
    expect(updates).toHaveLength(1);
    expect(updates[0].where.id).toBe('order-2');
    expect(updates[0].data.status).toBe('CANCELLED');
    expect(updates[0].where.status.in).toEqual(expect.arrayContaining(['CREATED', 'MATCHED']));
  });
});
