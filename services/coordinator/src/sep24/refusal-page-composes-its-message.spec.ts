import 'reflect-metadata';
import { Sep24Service } from './sep24.service';

function harness(kycRow: any, refusedAnywhere: any) {
  const prisma = {
    sep24Transaction: {
      findUnique: jest.fn(async () => ({
        id: 'tx-1',
        stellarAccount: 'GABC',
        personId: 'person-1',
        orderId: null,
        startedAt: new Date(),
        flow: 'TOP_UP',
        order: null,
      })),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    kycVerification: {
      findUnique: jest.fn(async () => kycRow),
      findFirst: jest.fn(async (args: any) => (args.where.status === 'REJECTED' ? refusedAnywhere : null)),
    },
    order: { updateMany: jest.fn(async () => ({ count: 1 })) },
  } as any;
  const cfg = {
    anchorBaseUrl: 'https://api.lolipay.app',
    usdcAssetCode: 'USDC',
    usdcAssetIssuer: 'GISSUER',
    jwtSecret: ['unit', 'test', 'key', '0123456789'].join('-'),
    jwtIssuer: 'https://lolipay.app',
    jwtAudience: 'lolipay-app',
    kycRequireAml: true,
  } as any;
  const people = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) } as any;
  const svc = new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, people, {} as any, {} as any, { isConfigured: false } as any);
  return { svc, cfg };
}

describe('the refusal page composes its sentence and never copies an internal marker from a wallet row', () => {
  it('says only that the identity was refused when the person is refused under another wallet whose reason was erased, while this wallet carries the unreadable marker', async () => {
    const { svc, cfg } = harness(
      { status: 'NEEDS_INFO', rejectionReason: 'the screening could not be read', screenedAt: null, deliveredAt: new Date() },
      { rejectionReason: null },
    );
    const { mintInteractiveToken } = await import('./interactive-token');
    const html = await svc.renderInteractive('tx-1', mintInteractiveToken(cfg, 'tx-1', 'GABC'));
    expect(html).toContain('Verification refused');
    expect(html).toContain('This identity was refused.');
    expect(html).not.toContain('the screening could not be read');
  });

  it('still shows the refusal reason the refused row itself carries', async () => {
    const { svc, cfg } = harness(
      { status: 'REJECTED', rejectionReason: 'sanctions or watchlist match', screenedAt: null, deliveredAt: new Date() },
      { rejectionReason: 'sanctions or watchlist match' },
    );
    const { mintInteractiveToken } = await import('./interactive-token');
    const html = await svc.renderInteractive('tx-1', mintInteractiveToken(cfg, 'tx-1', 'GABC'));
    expect(html).toContain('sanctions or watchlist match');
  });
});
