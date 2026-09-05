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

function depositAt(orderStatus: string) {
  const order = {
    id: 'order-1',
    status: orderStatus,
    personId: 'person-1',
    tradeId: 'a'.repeat(64),
    contractId: 'CESCROW',
    flow: 'TOP_UP',
    userAddress: 'GUSER',
    lpWallet: 'GLP',
    usdcAmount: 111700000n,
    fiatAmount: 200000n,
    fiatCurrency: 'IDR',
    platformFeeBps: 30,
    lpFeeBps: 120,
    payDeadline: 1n,
    confirmDeadline: 2n,
    lp: { stellarAddress: 'GLP' },
  };
  const row = { id: 'tx-1', orderId: 'order-1', stellarAccount: 'GUSER', personId: 'person-1', flow: 'TOP_UP', order };
  const accepted = { customerRef: 'GUSER', personId: 'person-1', status: 'ACCEPTED', screenedAt: new Date(), deliveredAt: new Date() };
  const prisma: any = {
    sep24Transaction: { findUnique: async () => row },
    order: { findUnique: async () => order },
    kycVerification: { findUnique: async () => accepted, findFirst: async (a: any) => (a?.where?.status === 'REJECTED' ? null : accepted) },
  };
  const orderStatusService: any = { refreshOrderStatus: async () => order };
  const people: any = { lookupPerson: async () => ({ id: 'person-1' }) };
  const service = new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, people, {} as any, orderStatusService, { isConfigured: false } as any);
  return service.renderInteractive('tx-1', mintInteractiveToken(cfg, 'tx-1', 'GUSER'));
}

describe('the settled screen of a deposit', () => {
  it('keeps refreshing after the rupiah was attested, so the person sees the deposit complete', async () => {
    const html = await depositAt('FIAT_PAID');
    expect(html).toContain('Deposit status');
    expect(html).toContain('http-equiv="refresh" content="15"');
  });

  it('stops refreshing once the deposit is completed', async () => {
    const html = await depositAt('RELEASED');
    expect(html).toContain('Deposit status');
    expect(html).not.toContain('http-equiv="refresh"');
  });
});
