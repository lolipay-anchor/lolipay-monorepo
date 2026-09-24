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

function withdrawalAt(orderStatus: string, payDeadline: bigint, confirmDeadline: bigint) {
  const order = {
    id: 'order-1',
    status: orderStatus,
    personId: 'person-1',
    flow: 'WITHDRAW',
    usdcAmount: 111700000n,
    fiatAmount: 200000n,
    fiatCurrency: 'IDR',
    platformFeeBps: 30,
    lpFeeBps: 120,
    payDeadline,
    confirmDeadline,
    userPaymentDetails: 'BCA 1234567890',
  };
  const row = { id: 'tx-1', orderId: 'order-1', stellarAccount: 'GUSER', personId: 'person-1', flow: 'WITHDRAW', order };
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

describe('the withdrawal signing screen names its deadlines in Jakarta time', () => {
  it('wraps both the refund-after instant and the sign-before instant as WIB, with the UTC instant kept machine-readable', async () => {
    const html = await withdrawalAt('MATCHED', 4_000_000_000n, 4_000_010_000n);
    expect(html).toContain('<strong><time datetime="2096-10-02T09:53:20.000Z">2 October 2096 at 16:53 WIB</time></strong>');
    expect(html).toContain('<strong><time datetime="2096-10-02T06:55:40.000Z">2 October 2096 at 13:55 WIB</time></strong>');
    expect(html).not.toContain('2096-10-02T09:53:20.000Z<');
    expect(html).not.toContain('2096-10-02T06:55:40.000Z<');
  });

  it('names the closed instant in WIB once the signing window has passed', async () => {
    const html = await withdrawalAt('MATCHED', 1_700_000_000n, 1_700_010_000n);
    expect(html).toContain('This signing window has closed');
    expect(html).toContain('<strong><time datetime="2023-11-14T22:02:20.000Z">15 November 2023 at 05:02 WIB</time></strong>');
  });
});

describe('the waiting-on-fiat screen also names its deadline in WIB', () => {
  it('wraps the refund-eligible instant as WIB, with the UTC instant kept machine-readable', async () => {
    const html = await withdrawalAt('FUNDED', 4_000_000_000n, 4_000_020_000n);
    expect(html).toContain('<strong><time datetime="2096-10-02T12:40:00.000Z">2 October 2096 at 19:40 WIB</time></strong>');
    expect(html).not.toContain('2096-10-02T12:40:00.000Z<');
  });
});
