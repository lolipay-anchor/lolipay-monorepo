import { Sep24Service } from './sep24.service';
import { explorerTxUrl } from './explorer-url';

const TESTNET = 'Test SDF Network ; September 2015';
const HASH = 'ab'.repeat(32);

function service(order: Record<string, unknown>) {
  const prisma: any = {
    sep24Transaction: {
      findUnique: jest.fn(async () => ({
        id: 'tx-1',
        stellarAccount: 'GABC',
        personId: 'person-1',
        startedAt: new Date('2026-09-05T17:00:00.000Z'),
        flow: 'TOP_UP',
        order: { personId: 'person-1', ...order },
      })),
    },
    kycVerification: { findMany: jest.fn(async () => []) },
  };
  const cfg = {
    anchorBaseUrl: 'https://api.lolipay.app',
    usdcAssetCode: 'USDC',
    usdcAssetIssuer: 'GISSUER',
    networkPassphrase: TESTNET,
    kycRequireAml: true,
  } as any;
  return new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { isConfigured: false } as any);
}

const baseOrder = {
  usdcAmount: 111700000n,
  fiatAmount: 200000n,
  fiatCurrency: 'IDR',
  platformFeeBps: 30,
  lpFeeBps: 120,
  ref: null,
  payDeadline: 1n,
  confirmDeadline: 2n,
  flow: 'TOP_UP',
};

describe('where a settlement can be seen', () => {
  it('points at stellar.expert on the network the anchor runs on, with the hash made safe for a URL', () => {
    expect(explorerTxUrl(TESTNET, 'abc')).toBe('https://stellar.expert/explorer/testnet/tx/abc');
    expect(explorerTxUrl('Public Global Stellar Network ; September 2015', 'abc')).toBe('https://stellar.expert/explorer/public/tx/abc');
    expect(explorerTxUrl(TESTNET, '<x>')).toBe('https://stellar.expert/explorer/testnet/tx/%3Cx%3E');
    expect(explorerTxUrl('Some Other Network ; 2030', 'abc')).toBeNull();
    expect(explorerTxUrl('toString', 'abc')).toBeNull();
  });
});

describe('the more-info page of a deposit', () => {
  it('links a completed deposit to its settlement on stellar.expert', async () => {
    const html = await service({ ...baseOrder, status: 'RELEASED', settlementTxHash: HASH, settledAt: new Date('2026-09-05T17:30:00.000Z') }).moreInfo('tx-1');
    expect(html).toContain('Settled on Stellar');
    expect(html).toContain(`href="https://stellar.expert/explorer/testnet/tx/${HASH}"`);
    expect(html).toContain(`>${HASH}</a>`);
  });

  it('shows no settlement while the deposit is still funded', async () => {
    const html = await service({ ...baseOrder, status: 'FUNDED', settlementTxHash: null, settledAt: null }).moreInfo('tx-1');
    expect(html).not.toContain('Settled on Stellar');
    expect(html).not.toContain('stellar.expert');
  });

  it('tells a funded depositor where to send the rupiah, with the amount, the reference and the deadline, so a wallet that closed the popup still has them', async () => {
    const html = await service({
      ...baseOrder,
      status: 'FUNDED',
      settlementTxHash: null,
      settledAt: null,
      lpPaymentDetails: 'BCA 1234567890 a.n. Budi <Santoso>',
      ref: 'LP-42',
      payDeadline: 1_800_000_000n,
    }).moreInfo('tx-1');
    expect(html).toContain('Send <strong>200.000</strong> IDR to:');
    expect(html).toContain('<pre>BCA 1234567890 a.n. Budi &lt;Santoso&gt;</pre>');
    expect(html).toContain('Reference: <strong>LP-42</strong>');
    expect(html).toContain('Send it before <strong>2027-01-15T08:00:00.000Z</strong>');
  });

  it('shows no bank details once the deposit has left FUNDED, and never for a withdrawal', async () => {
    const released = await service({ ...baseOrder, status: 'RELEASED', settlementTxHash: HASH, settledAt: new Date(), lpPaymentDetails: 'BCA 1234567890' }).moreInfo('tx-1');
    expect(released).not.toContain('BCA 1234567890');
    expect(released).not.toContain('Send <strong>');
    const withdrawal = service({ ...baseOrder, status: 'FUNDED', settlementTxHash: null, settledAt: null, lpPaymentDetails: 'BCA 1234567890', flow: 'WITHDRAW' });
    (withdrawal as any).prisma.sep24Transaction.findUnique = jest.fn(async () => ({
      id: 'tx-1', stellarAccount: 'GABC', personId: 'person-1', startedAt: new Date('2026-09-05T17:00:00.000Z'), flow: 'WITHDRAW',
      order: { personId: 'person-1', ...baseOrder, status: 'FUNDED', settlementTxHash: null, settledAt: null, lpPaymentDetails: 'BCA 1234567890', flow: 'WITHDRAW' },
    }));
    const html = await withdrawal.moreInfo('tx-1');
    expect(html).not.toContain('BCA 1234567890');
  });

  it('shows the hash without a link on a network it does not know', async () => {
    const svc = service({ ...baseOrder, status: 'RELEASED', settlementTxHash: HASH, settledAt: new Date() });
    (svc as any).cfg.networkPassphrase = 'Standalone Network ; February 2017';
    const html = await svc.moreInfo('tx-1');
    expect(html).toContain('Settled on Stellar');
    expect(html).toContain(HASH);
    expect(html).not.toContain('stellar.expert');
  });

  it('calls a refund what it is', async () => {
    const html = await service({ ...baseOrder, status: 'REFUNDED', settlementTxHash: HASH, settledAt: new Date('2026-09-05T17:30:00.000Z') }).moreInfo('tx-1');
    expect(html).toContain('Refunded on Stellar');
    expect(html).not.toContain('Settled on Stellar');
  });

  it('never lets a hash reach the page unescaped', async () => {
    const html = await service({ ...baseOrder, status: 'RELEASED', settlementTxHash: '<x>', settledAt: new Date() }).moreInfo('tx-1');
    expect(html).not.toContain('<x>');
    expect(html).toContain('%3Cx%3E');
    expect(html).toContain('&lt;x&gt;');
  });
});
