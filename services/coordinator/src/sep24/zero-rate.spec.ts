import { Sep24Service } from './sep24.service';
import { mintInteractiveToken } from './interactive-token';

const cfg = {
  anchorBaseUrl: 'https://api.lolipay.app',
  usdcAssetCode: 'USDC',
  usdcAssetIssuer: 'GISSUER',
  networkPassphrase: 'Test SDF Network ; September 2015',
  kycRequireAml: true,
  jwtSecret: ['unit', 'test', 'key', '0123456789'].join('-'),
  jwtIssuer: 'https://lolipay.app',
  jwtAudience: 'lolipay-app',
} as any;

function render(flow: 'TOP_UP' | 'WITHDRAW', status: string, usdcAmount: bigint, fiatAmount = 200000n) {
  const order = {
    id: 'order-1',
    status,
    personId: 'person-1',
    flow,
    usdcAmount,
    fiatAmount,
    fiatCurrency: 'IDR',
    platformFeeBps: 30,
    lpFeeBps: 120,
    payDeadline: 4_000_000_000n,
    confirmDeadline: 4_000_010_000n,
    ref: 'LP-42',
    lpPaymentLabel: 'BCA',
    lpPaymentDetails: '1231231231',
    userPaymentDetails: 'BCA 1234567890',
    rail: 'BANK',
  };
  const row = { id: 'tx-1', orderId: 'order-1', stellarAccount: 'GUSER', personId: 'person-1', flow, order };
  const accepted = { customerRef: 'GUSER', personId: 'person-1', status: 'ACCEPTED', screenedAt: new Date(), deliveredAt: new Date() };
  const prisma: any = {
    sep24Transaction: { findUnique: async () => row },
    order: { findUnique: async () => order },
    kycVerification: {
      findUnique: async () => accepted,
      findFirst: async (a: any) => (a?.where?.status === 'REJECTED' ? null : accepted),
    },
    config: { findUnique: async () => null },
  };
  const orderStatusService: any = { refreshOrderStatus: async () => order };
  const people: any = { lookupPerson: async () => ({ id: 'person-1' }) };
  const service = new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, people, {} as any, orderStatusService, { isConfigured: false } as any);
  return service.renderInteractive('tx-1', mintInteractiveToken(cfg, 'tx-1', 'GUSER'));
}

describe('the withdrawal signing screen states a rate only when it has one', () => {
  it('quotes the effective rate on an ordinary order', async () => {
    const html = await render('WITHDRAW', 'MATCHED', 111700000n);
    expect(html).toContain('Sign to lock your USDC');
    expect(html).toContain('<p>Rate: 1 USDC ≈ <strong>17.905</strong> IDR, fixed for this order.</p>');
  });

  it('drops the rate but keeps the binding promise when a tiny fiat amount against a real escrow cannot express one', async () => {
    const html = await render('WITHDRAW', 'MATCHED', 3_0000000n, 1n);
    expect(html).toContain('Sign to lock your USDC');
    expect(html).toContain('<strong>3</strong> USDC into escrow');
    expect(html).toContain('<strong>1</strong> IDR');
    expect(html).not.toMatch(/1 USDC ≈/);
    expect(html).toContain('<p>Both amounts above are fixed for this order.</p>');
  });

  it('says nothing about a rate when the escrowed amount cannot yield one, rather than promising a rate of zero', async () => {
    const html = await render('WITHDRAW', 'MATCHED', 0n);
    expect(html).toContain('Sign to lock your USDC');
    expect(html).not.toMatch(/1 USDC ≈/);
    expect(html).toContain('<p>Both amounts above are fixed for this order.</p>');
    expect(html).not.toContain('<strong></strong>');
  });
});

describe('the deposit instructions screen states a rate only when it has one', () => {
  it('quotes the effective rate on an ordinary order', async () => {
    const html = await render('TOP_UP', 'FUNDED', 111700000n);
    expect(html).toContain('Send your rupiah');
    expect(html).toContain('1 USDC ≈ <strong>17.905</strong> IDR on the <strong>11.17</strong> USDC escrowed');
    expect(html).toContain('all fixed for this order.');
  });

  it('keeps the amount, the escrow and the fee meaningful when a tiny fiat amount against a real escrow cannot express a rate', async () => {
    const html = await render('TOP_UP', 'FUNDED', 3_0000000n, 1n);
    expect(html).toContain('Send your rupiah');
    expect(html).not.toMatch(/1 USDC ≈/);
    expect(html).toContain(
      '<p>You receive <strong>2.955</strong> USDC for it, out of the <strong>3</strong> USDC escrowed, minus a fee of <strong>0.045</strong> USDC (1.5%), all fixed for this order.</p>',
    );
  });

  it('still tells the depositor where to pay, but promises nothing about a rate it cannot compute', async () => {
    const html = await render('TOP_UP', 'FUNDED', 0n);
    expect(html).toContain('Send your rupiah');
    expect(html).toContain('How to pay');
    expect(html).not.toMatch(/1 USDC ≈/);
    expect(html).toContain('USDC for it, out of the <strong>0</strong> USDC escrowed, minus a fee of <strong>0</strong> USDC (1.5%), all fixed for this order.');
    expect(html).not.toContain('<strong></strong>');
  });
});
