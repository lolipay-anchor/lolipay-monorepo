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
        findFirst: jest.fn(async () => null),
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
});
