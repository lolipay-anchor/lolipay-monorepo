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

function depositAt(payDeadline: bigint, confirmDeadline: bigint) {
  const order = {
    id: 'order-1',
    status: 'FUNDED',
    personId: 'person-1',
    flow: 'TOP_UP',
    usdcAmount: 111700000n,
    fiatAmount: 200000n,
    fiatCurrency: 'IDR',
    platformFeeBps: 30,
    lpFeeBps: 120,
    payDeadline,
    confirmDeadline,
    ref: 'LP-42',
    lpPaymentLabel: 'BCA',
    lpPaymentDetails: '1231231231',
    rail: 'BANK',
  };
  const row = { id: 'tx-1', orderId: 'order-1', stellarAccount: 'GUSER', personId: 'person-1', flow: 'TOP_UP', order };
  const accepted = { customerRef: 'GUSER', personId: 'person-1', status: 'ACCEPTED', screenedAt: new Date(), deliveredAt: new Date() };
  const prisma: any = {
    sep24Transaction: { findUnique: async () => row },
    order: { findUnique: async () => order },
    kycVerification: {
      findUnique: async () => accepted,
      findFirst: async (a: any) => (a?.where?.status === 'REJECTED' ? null : accepted),
    },
  };
  const orderStatusService: any = { refreshOrderStatus: async () => order };
  const people: any = { lookupPerson: async () => ({ id: 'person-1' }) };
  const service = new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, people, {} as any, orderStatusService, { isConfigured: false } as any);
  return service.renderInteractive('tx-1', mintInteractiveToken(cfg, 'tx-1', 'GUSER'));
}

describe('the deposit instructions screen names the confirm-by instant in WIB', () => {
  it('wraps the confirm-eligible instant as WIB, with the UTC instant kept machine-readable', async () => {
    const html = await depositAt(4_000_000_000n, 4_000_010_000n);
    expect(html).toContain('<strong><time datetime="2096-10-02T08:06:40.000Z">2 October 2096 at 15:06 WIB</time></strong>');
    expect(html).not.toContain('2096-10-02T08:06:40.000Z<');
  });
});
