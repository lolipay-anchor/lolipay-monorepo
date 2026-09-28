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

function depositAt(payDeadline: bigint, confirmDeadline: bigint, overrides: Record<string, unknown> = {}) {
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
    ...overrides,
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

describe('once the depositor has claimed they sent the rupiah, ADR 0059', () => {
  it('stops asking them to send it and never falls back to another page that also lies', async () => {
    const unclaimed = await depositAt(4_000_000_000n, 4_000_010_000n);
    expect(unclaimed).toContain('Send your rupiah');
    expect(unclaimed).toContain('How to pay');

    const html = await depositAt(4_000_000_000n, 4_000_010_000n, {
      userClaimedPaidAt: new Date('2026-09-25T00:00:00.000Z'),
    });
    expect(html).not.toContain('Send your rupiah');
    expect(html).not.toContain('How to pay');
    expect(html).not.toMatch(/Status: <strong>pending_external<\/strong>/);
    expect(html).not.toContain('The time to pay has passed');
  });

  it('names the refund instant as something still to come only while it is still to come', async () => {
    const now = Math.floor(Date.now() / 1000);
    const claimed = { userClaimedPaidAt: new Date('2026-09-25T00:00:00.000Z') };

    const ahead = await depositAt(BigInt(now - 600), BigInt(now + 2_400), claimed);
    expect(ahead).toContain('We have asked the provider to check their account');
    expect(ahead).toContain('If it is not confirmed by');

    const behind = await depositAt(BigInt(now - 10_000), BigInt(now - 8_200), claimed);
    expect(behind).toContain('We have asked the provider to check their account');
    expect(behind).not.toContain('If it is not confirmed by');
  });
});

describe('a refund promise on the deposit screens says the route can open, never that it will run', () => {
  it('says so on the instructions screen, before the depositor has claimed anything', async () => {
    const html = await depositAt(4_000_000_000n, 4_000_010_000n);
    expect(html).toContain('after which the escrow can be returned to the provider');
    expect(html).not.toMatch(/escrow returns/i);
  });

  it('says so on the confirmation screen, and stops telling them to keep a receipt only until the instant their evidence becomes useful', async () => {
    const now = Math.floor(Date.now() / 1000);
    const html = await depositAt(BigInt(now - 600), BigInt(now + 2_400), {
      userClaimedPaidAt: new Date('2026-09-25T00:00:00.000Z'),
    });
    expect(html).toContain('the escrow can be returned to the provider and this deposit closes without one');
    expect(html).toContain('<strong>Keep your transfer receipt.</strong>');
    expect(html).not.toMatch(/escrow returns/i);
    expect(html).not.toMatch(/until then/i);
  });
});
