import { Sep24Service } from './sep24.service';

function harness() {
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
      updateMany: jest.fn(async () => ({ count: 1 })),
      update: jest.fn(async () => ({})),
    },
    kycVerification: {
      findUnique: jest.fn(async () => ({ status: 'ACCEPTED', screenedAt: new Date() })),
      findFirst: jest.fn(async (args: any) => (args.where.status === 'ACCEPTED' ? { customerRef: 'GABC' } : null)),
    },
    order: { updateMany: jest.fn(async () => ({ count: 1 })) },
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
  const svc = new Sep24Service(prisma, cfg, {} as any, rate, orders, people, {} as any, {} as any);
  return { svc, cfg, rate };
}

describe('the amount step reads rupiah the way an Indonesian types it', () => {
  it('turns "Rp 200.000" into the two hundred thousand rupiah the quote is asked for', async () => {
    const { svc, cfg, rate } = harness();
    const { mintInteractiveToken } = await import('./interactive-token');
    const token = mintInteractiveToken(cfg, 'tx-1', 'GABC');
    await svc.submitAmount('tx-1', token, 'Rp 200.000');
    expect(rate.createQuote).toHaveBeenCalledWith('GABC', 'TOP_UP', 'BANK', { fiatAmount: 200000n });
  });

  it('refuses an amount with no digits at all', async () => {
    const { svc, cfg, rate } = harness();
    const { mintInteractiveToken } = await import('./interactive-token');
    const token = mintInteractiveToken(cfg, 'tx-1', 'GABC');
    await expect(svc.submitAmount('tx-1', token, 'Rp')).rejects.toThrow(/name an amount/);
    expect(rate.createQuote).not.toHaveBeenCalled();
  });
});
