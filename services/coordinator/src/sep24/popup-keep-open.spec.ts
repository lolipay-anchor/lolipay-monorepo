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

function renderDeposit(userClaimedPaidAt: Date | null) {
  const now = Math.floor(Date.now() / 1000);
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
    payDeadline: BigInt(now + 1_800),
    confirmDeadline: BigInt(now + 3_600),
    ref: 'LP-42',
    lpPaymentLabel: 'BCA',
    lpPaymentDetails: '1231231231',
    rail: 'BANK',
    userClaimedPaidAt,
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

describe('the popup tells the depositor to keep it open, because the reference wallet stops polling once it is closed', () => {
  it('on the claim_received screen, where it replaces the invitation to close it', async () => {
    const html = await renderDeposit(new Date());
    expect(html).toContain('That is recorded on this deposit.');
    expect(html).toContain(
      '<p>Keep this window open: it updates itself until the deposit completes or closes. If it is closed, your wallet may stop following this deposit. That changes nothing about the deposit itself. To check on it later, sign in with this same wallet at <a href="https://app.lolipay.app">app.lolipay.app</a>: the order appears there with its evidence.</p>',
    );
    expect(html).not.toMatch(/you may close it|will show the deposit/i);
  });

  it('in the claim control before the pay deadline, where it replaces the promise that the wallet will show the deposit', async () => {
    const html = await renderDeposit(null);
    expect(html).toContain('<h2>Already sent it?</h2>');
    expect(html).toContain(
      '<p>Keep this window open: it updates itself until the deposit completes or closes. If it is closed, your wallet may stop following this deposit. The deposit itself carries on either way.</p>',
    );
    expect(html).not.toMatch(/you may close it|will show the deposit/i);
  });
});
