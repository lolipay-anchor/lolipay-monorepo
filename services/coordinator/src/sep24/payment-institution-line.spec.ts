import { Sep24Service } from './sep24.service';

const TESTNET = 'Test SDF Network ; September 2015';

function projectingService(rawOrder: Record<string, unknown>) {
  const prisma: any = {
    sep24Transaction: {
      findUnique: jest.fn(async (args: any) => {
        const select = args?.include?.order?.select as Record<string, boolean> | undefined;
        const projected = select
          ? Object.fromEntries(
              Object.keys(select)
                .filter((k) => select[k])
                .map((k) => [k, (rawOrder as any)[k]]),
            )
          : rawOrder;
        return {
          id: 'tx-1',
          stellarAccount: 'GABC',
          personId: 'person-1',
          startedAt: new Date('2026-09-24T00:00:00.000Z'),
          flow: rawOrder.flow,
          order: { personId: 'person-1', ...projected },
        };
      }),
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
  const svc = new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, { isConfigured: false } as any);
  return { svc, prisma };
}

const rawOrder = {
  status: 'FUNDED',
  usdcAmount: 111700000n,
  fiatAmount: 1600000n,
  fiatCurrency: 'IDR',
  platformFeeBps: 30,
  lpFeeBps: 120,
  settlementTxHash: null,
  settledAt: null,
  personId: 'person-1',
  ref: 'LP-42',
  payDeadline: 4_000_000_000n,
  confirmDeadline: 4_000_001_800n,
  flow: 'TOP_UP',
  rail: 'BANK',
  lpPaymentLabel: 'BCA',
  lpPaymentDetails: '1231231231',
};

describe('the popup names the institution a bare account number belongs to', () => {
  it('shows the institution and the rail word beside the account number', async () => {
    const { svc } = projectingService(rawOrder);
    const html = await svc.moreInfo('tx-1');
    expect(html).toContain('BCA');
    expect(html).toContain('bank account');
    expect(html).toContain('1231231231');
  });

  it('wraps the institution and the account number each in their own dir="ltr" run, not one shared run', async () => {
    const { svc } = projectingService(rawOrder);
    const html = await svc.moreInfo('tx-1');
    expect(html).toContain('<pre dir="ltr">1231231231</pre>');
    expect(html).toMatch(/<[a-z]+[^>]*\sdir="ltr"[^>]*>BCA</);
  });

  it('never renders the institution as a standalone line — it fills a noun slot in a lolipay-authored sentence', async () => {
    const { svc } = projectingService(rawOrder);
    const html = await svc.moreInfo('tx-1');
    expect(html).not.toMatch(/<p[^>]*>\s*<code[^>]*>BCA<\/code>\s*bank account\s*<\/p>/);
    expect(html).toContain('to the <span dir="ltr">BCA</span> bank account below:</p>');
  });

  it('keeps a lolipay-authored word between the institution and the raw account number, so they cannot be read as one instruction', async () => {
    const { svc } = projectingService(rawOrder);
    const html = await svc.moreInfo('tx-1');
    const labelIndex = html.indexOf('BCA');
    const accountIndex = html.indexOf('1231231231');
    expect(labelIndex).toBeGreaterThan(-1);
    expect(accountIndex).toBeGreaterThan(labelIndex);
    const between = html.slice(labelIndex, accountIndex);
    expect(between).toMatch(/bank account below/);
  });

  it('renders the institution plainly, never carrying the account number\'s monospace verbatim styling, so lolipay is never read as the author of a typo', async () => {
    const { svc } = projectingService({ ...rawOrder, lpPaymentLabel: 'bca' });
    const html = await svc.moreInfo('tx-1');
    expect(html).not.toContain('<strong>bca</strong>');
    expect(html).toContain('<span dir="ltr">bca</span>');
    const paymentBlock = html.slice(html.indexOf('<h2>How to pay'), html.indexOf('Send it before'));
    expect(paymentBlock).not.toContain('<code');
  });

  it('renders the pay-by deadline as WIB for a human, with the UTC instant kept machine-readable', async () => {
    const { svc } = projectingService(rawOrder);
    const html = await svc.moreInfo('tx-1');
    expect(html).toContain('<span dir="ltr">BCA</span>');
    expect(html).toContain('<time datetime="2096-10-02T07:06:40.000Z">2 October 2096 at 14:06 WIB</time>');
    expect(html).not.toContain('2096-10-02T07:06:40.000Z<');
  });

  it('gives the payment block its own heading for a screen-reader to jump to', async () => {
    const { svc } = projectingService(rawOrder);
    const html = await svc.moreInfo('tx-1');
    expect(html).toMatch(/<h2>[^<]+<\/h2><p[^>]*>Send/);
  });

  it('never promises to show a provider that has not been assigned, and shows the absence as an empty block instead', async () => {
    const { svc } = projectingService({ ...rawOrder, lpPaymentDetails: null });
    const html = await svc.moreInfo('tx-1');
    expect(html).not.toContain('your provider will be shown here');
    expect(html).toContain('<pre dir="ltr"></pre>');
  });

  it('drops the reference row entirely rather than showing a labelled blank', async () => {
    const { svc } = projectingService({ ...rawOrder, ref: null });
    const html = await svc.moreInfo('tx-1');
    expect(html).not.toContain('Reference:');
  });

  it('says e-wallet for an e-wallet rail and QRIS code for a QRIS rail', async () => {
    const { svc: ewalletSvc } = projectingService({ ...rawOrder, rail: 'EWALLET' });
    expect(await ewalletSvc.moreInfo('tx-1')).toContain('e-wallet');
    const { svc: qrisSvc } = projectingService({ ...rawOrder, rail: 'QRIS' });
    expect(await qrisSvc.moreInfo('tx-1')).toContain('QRIS code');
  });

  it('falls back to a bare account with no institution line for an order written before the label column existed', async () => {
    const { svc } = projectingService({ ...rawOrder, lpPaymentLabel: null });
    const html = await svc.moreInfo('tx-1');
    expect(html).not.toContain('bank account');
    expect(html).not.toContain('BCA');
    expect(html).toContain('<pre dir="ltr">1231231231</pre>');
  });

  it('never names an institution on a withdrawal, which has no LP-side label to show', async () => {
    const { svc } = projectingService({ ...rawOrder, flow: 'WITHDRAW' });
    const html = await svc.moreInfo('tx-1');
    expect(html).not.toContain('BCA');
    expect(html).not.toContain('bank account');
  });
});
