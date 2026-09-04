import { Sep24Service } from './sep24.service';

function harness(flow: 'TOP_UP' | 'WITHDRAW' = 'TOP_UP') {
  const prisma: any = {
    sep24Transaction: {
      findUnique: jest.fn(async () => ({
        id: 'tx-1',
        stellarAccount: 'GABC',
        personId: 'person-1',
        orderId: null,
        startedAt: new Date(),
        flow,
        order: null,
      })),
      updateMany: jest.fn(async () => ({ count: 1 })),
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

  it.each([
    ['200,000', 'a comma'],
    ['200,000.00', 'a comma and a fraction'],
    ['1,5', 'a comma fraction'],
    ['Rp 200,000', 'a comma after Rp'],
    ['150000.00', 'a two-digit fraction that stripping would read as 15 million'],
    ['1500.75', 'a fraction'],
    ['0.500', 'a leading zero group'],
    ['150000\uFF0C00', 'a fullwidth comma'],
    ['150000\u060C00', 'an Arabic comma'],
    ['150000\uFF10', 'a fullwidth digit mixed in'],
    ['-150000', 'a sign'],
    ['2e5', 'an exponent'],
    ['200 000', 'a space group'],
    ['200k', 'a suffix'],
  ])('refuses "%s" (%s) with a clear message rather than guessing what it means', async (raw) => {
    const { svc, cfg, rate } = harness();
    const { mintInteractiveToken } = await import('./interactive-token');
    const token = mintInteractiveToken(cfg, 'tx-1', 'GABC');
    await expect(svc.submitAmount('tx-1', token, raw)).rejects.toThrow(/plain digits|dots as thousands/);
    expect(rate.createQuote).not.toHaveBeenCalled();
  });

  it.each([
    ['1.500.000', 1500000n],
    ['Rp 200.000', 200000n],
    ['Rp. 200.000', 200000n],
    ['0200000', 200000n],
    [' 200000 ', 200000n],
  ])('still takes "%s", a form an Indonesian keyboard produces, as %s rupiah', async (raw, fiatAmount) => {
    const { svc, cfg, rate } = harness();
    const { mintInteractiveToken } = await import('./interactive-token');
    const token = mintInteractiveToken(cfg, 'tx-1', 'GABC');
    await svc.submitAmount('tx-1', token, raw);
    expect(rate.createQuote).toHaveBeenCalledWith('GABC', 'TOP_UP', 'BANK', { fiatAmount });
  });

  it.each([
    ['two form fields', ['200000', '000']],
    ['a JSON object', { toString: 'x' }],
    ['a JSON array of one', ['200000']],
    ['a JSON number', 200000],
  ])('refuses an amount that is not one string: %s', async (_label, raw) => {
    const { svc, cfg, rate } = harness();
    const { mintInteractiveToken } = await import('./interactive-token');
    const token = mintInteractiveToken(cfg, 'tx-1', 'GABC');
    await expect(svc.submitAmount('tx-1', token, raw as any)).rejects.toThrow(/name an amount/);
    expect(rate.createQuote).not.toHaveBeenCalled();
  });

  it('refuses more than eighteen digits before anything is quoted', async () => {
    const { svc, cfg, rate } = harness();
    const { mintInteractiveToken } = await import('./interactive-token');
    const token = mintInteractiveToken(cfg, 'tx-1', 'GABC');
    await expect(svc.submitAmount('tx-1', token, '9'.repeat(19))).rejects.toThrow(/name an amount/);
    expect(rate.createQuote).not.toHaveBeenCalled();
  });

  it('on a withdrawal, refuses a bank account that is not one string, and accepts one that is', async () => {
    const refused = harness('WITHDRAW');
    const { mintInteractiveToken } = await import('./interactive-token');
    const token = mintInteractiveToken(refused.cfg, 'tx-1', 'GABC');
    await expect(refused.svc.submitAmount('tx-1', token, '200000', { toString: 'x' } as any)).rejects.toThrow(/bank account/);
    await expect(refused.svc.submitAmount('tx-1', token, '200000', ['BCA 1', 'BCA 2'] as any)).rejects.toThrow(/bank account/);
    await expect(refused.svc.submitAmount('tx-1', token, '200000', undefined)).rejects.toThrow(/bank account/);
    expect(refused.rate.createQuote).not.toHaveBeenCalled();
    const honest = harness('WITHDRAW');
    await honest.svc.submitAmount('tx-1', mintInteractiveToken(honest.cfg, 'tx-1', 'GABC'), '200000', 'BCA 1234567890');
    expect(honest.rate.createQuote).toHaveBeenCalledWith('GABC', 'WITHDRAW', 'BANK', { fiatAmount: 200000n });
  });

  it('refuses zero rupiah as a bad request rather than letting the quote blow up', async () => {
    const { svc, cfg, rate } = harness();
    const { mintInteractiveToken } = await import('./interactive-token');
    const token = mintInteractiveToken(cfg, 'tx-1', 'GABC');
    await expect(svc.submitAmount('tx-1', token, 'Rp 0')).rejects.toThrow(/name an amount/);
    expect(rate.createQuote).not.toHaveBeenCalled();
  });

  it('refuses an amount with no digits at all', async () => {
    const { svc, cfg, rate } = harness();
    const { mintInteractiveToken } = await import('./interactive-token');
    const token = mintInteractiveToken(cfg, 'tx-1', 'GABC');
    await expect(svc.submitAmount('tx-1', token, 'Rp')).rejects.toThrow(/plain digits|dots as thousands/);
    expect(rate.createQuote).not.toHaveBeenCalled();
  });
});

describe('opening an interactive transaction without a body', () => {
  it('is refused as a bad request, not a crash, when no parser produced a body', async () => {
    const { svc } = harness();
    await expect(svc.openInteractive('GABC', 'person-1', undefined as any)).rejects.toThrow(/asset_code is required/);
  });
});
