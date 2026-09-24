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

  it('wraps the institution and the account number each in their own dir="ltr" block, not one shared run', async () => {
    const { svc } = projectingService(rawOrder);
    const html = await svc.moreInfo('tx-1');
    expect(html).toContain('<p dir="ltr"><strong>BCA</strong> bank account</p>');
    expect(html).toContain('<pre dir="ltr">1231231231</pre>');
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
