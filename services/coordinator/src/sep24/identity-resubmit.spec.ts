import { Sep24Service } from './sep24.service';
import { mintInteractiveToken } from './interactive-token';

describe('a second press of Continue lands on the screen that is current, not on a dead end', () => {
  function build(kyc: any) {
    const prisma: any = {
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
      },
      kycVerification: {
        findUnique: jest.fn(async () => kyc),
        findFirst: jest.fn(async ({ where }: any) =>
          where?.status === 'REJECTED' && kyc?.status === 'REJECTED'
            ? { rejectionReason: kyc.rejectionReason ?? null }
            : null,
        ),
      },
    };
    const cfg = {
      anchorBaseUrl: 'https://api.lolipay.app',
      usdcAssetCode: 'USDC',
      usdcAssetIssuer: 'GISSUER',
      jwtSecret: ['unit', 'test', 'key', '0123456789'].join('-'),
      jwtIssuer: 'https://lolipay.app',
      jwtAudience: 'lolipay-app',
      kycRequireAml: false,
    } as any;
    const sep12 = { put: jest.fn(async () => ({ id: 'GABC' })) } as any;
    const people = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) } as any;
    const svc = new Sep24Service(
      prisma,
      cfg,
      sep12,
      {} as any,
      {} as any,
      people,
      {} as any,
      {} as any,
      { isConfigured: false } as any,
    );
    return { svc, sep12, token: mintInteractiveToken(cfg, 'tx-1', 'GABC') };
  }

  it('does not refuse the duplicate, because the first press already created the session', async () => {
    const { svc, token } = build({
      status: 'PROCESSING',
      providerRef: 'p1',
      verificationUrl: 'https://verify.didit.me/s/1',
      updatedAt: new Date(),
      screenedAt: null,
      deliveredAt: null,
    });

    await expect(svc.submitIdentity('tx-1', token, { first_name: 'A' })).resolves.not.toThrow();
  });

  it('does not send the details a second time, so the vendor is not asked twice for one person', async () => {
    const { svc, sep12, token } = build({
      status: 'PROCESSING',
      providerRef: 'p1',
      verificationUrl: 'https://verify.didit.me/s/1',
      updatedAt: new Date(),
      screenedAt: null,
      deliveredAt: null,
    });

    await svc.submitIdentity('tx-1', token, { first_name: 'A' });

    expect(sep12.put).not.toHaveBeenCalled();
  });

  it('still sends the details when the form is genuinely the current screen', async () => {
    const { svc, sep12, token } = build(null);

    await svc.submitIdentity('tx-1', token, { first_name: 'A' });

    expect(sep12.put).toHaveBeenCalledWith('GABC', { first_name: 'A' });
  });

  it('shows the form again to someone accepted long ago whose result the provider never delivered, because the popup is the only surface they have and it was telling them to keep waiting forever', async () => {
    const longAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const { svc, sep12, token } = build({
      status: 'ACCEPTED',
      providerRef: 'p1',
      verificationUrl: 'https://verify.didit.me/s/1',
      updatedAt: longAgo,
      verifiedAt: longAgo,
      screenedAt: null,
      deliveredAt: null,
    });

    await svc.submitIdentity('tx-1', token, { first_name: 'A' });

    expect(sep12.put).toHaveBeenCalledWith('GABC', { first_name: 'A' });
  });

  it('never sends the details of an identity this anchor has refused, because the refused screen is not a form and a permanent refusal must not be shown a retry', async () => {
    const { svc, sep12, token } = build({
      status: 'REJECTED',
      rejectionReason: 'sanctions or watchlist match',
      providerRef: 'p1',
      verificationUrl: 'https://verify.didit.me/s/1',
      updatedAt: new Date(),
      verifiedAt: new Date(),
      screenedAt: null,
      deliveredAt: null,
    });

    await svc.submitIdentity('tx-1', token, { first_name: 'A' });

    expect(sep12.put).not.toHaveBeenCalled();
  });

  it('keeps waiting on an acceptance written moments ago, so the screen the anchor test suite reads back within seconds is unchanged', async () => {
    const { svc, sep12, token } = build({
      status: 'ACCEPTED',
      providerRef: 'p1',
      verificationUrl: 'https://verify.didit.me/s/1',
      updatedAt: new Date(),
      verifiedAt: new Date(),
      screenedAt: null,
      deliveredAt: null,
    });

    await svc.submitIdentity('tx-1', token, { first_name: 'A' });

    expect(sep12.put).not.toHaveBeenCalled();
  });
});
