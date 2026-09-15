import 'reflect-metadata';
import { Sep24Service } from './sep24.service';
import { mintInteractiveToken } from './interactive-token';

const DAY = 24 * 60 * 60 * 1000;
const RESTART_SENTENCE =
  'Your previous verification did not finish, so lolipay can no longer use it. Enter your details below and we will start a new one — this does not affect the USDC in your wallet.';
const IDENTITY_FORM_TITLE = '<h1>Verify your identity</h1>';

function harness(kycRow: any) {
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
    },
    kycVerification: {
      findUnique: jest.fn(async () => kycRow),
      findFirst: jest.fn(async () => null),
    },
  } as any;
  const cfg = {
    anchorBaseUrl: 'https://api.lolipay.app',
    usdcAssetCode: 'USDC',
    usdcAssetIssuer: 'GISSUER',
    jwtSecret: ['unit', 'test', 'key', '0123456789'].join('-'),
    jwtIssuer: 'https://lolipay.app',
    jwtAudience: 'lolipay-app',
    kycRequireAml: false,
  } as any;
  const people = { lookupPerson: jest.fn(async () => ({ id: 'person-1' })) } as any;
  const svc = new Sep24Service(prisma, cfg, {} as any, {} as any, {} as any, people, {} as any, {} as any, { isConfigured: false } as any);
  return { svc, cfg };
}

describe('the identity form explains a dead verification instead of greeting a returner as a first-timer', () => {
  it('adds the restart sentence for an acceptance the provider never delivered, old enough that a session cannot still be open', async () => {
    const { svc, cfg } = harness({
      status: 'ACCEPTED',
      providerRef: 'p1',
      verificationUrl: 'https://verify.didit.me/s/1',
      updatedAt: new Date(Date.now() - 40 * DAY),
      verifiedAt: new Date(Date.now() - 40 * DAY),
      screenedAt: null,
      deliveredAt: null,
    });

    const html = await svc.renderInteractive('tx-1', mintInteractiveToken(cfg, 'tx-1', 'GABC'));

    expect(html).toContain(IDENTITY_FORM_TITLE);
    expect(html).toContain(RESTART_SENTENCE);
  });

  it('adds the restart sentence for a PROCESSING session that went stale, the case no other test reaches', async () => {
    const { svc, cfg } = harness({
      status: 'PROCESSING',
      providerRef: 'p1',
      verificationUrl: 'https://verify.didit.me/s/1',
      updatedAt: new Date(Date.now() - 40 * DAY),
      verifiedAt: null,
      screenedAt: null,
      deliveredAt: null,
    });

    const html = await svc.renderInteractive('tx-1', mintInteractiveToken(cfg, 'tx-1', 'GABC'));

    expect(html).toContain(IDENTITY_FORM_TITLE);
    expect(html).toContain(RESTART_SENTENCE);
  });

  it('says nothing of the kind to a genuine first-timer, who has never opened a verification at all', async () => {
    const { svc, cfg } = harness(null);

    const html = await svc.renderInteractive('tx-1', mintInteractiveToken(cfg, 'tx-1', 'GABC'));

    expect(html).toContain(IDENTITY_FORM_TITLE);
    expect(html).not.toContain(RESTART_SENTENCE);
  });

  it('says nothing of the kind to a row genuinely marked NEEDS_INFO, whose incomplete answer this is not', async () => {
    const { svc, cfg } = harness({
      status: 'NEEDS_INFO',
      providerRef: 'p1',
      verificationUrl: 'https://verify.didit.me/s/1',
      updatedAt: new Date(),
      verifiedAt: null,
      screenedAt: null,
      deliveredAt: new Date(),
    });

    const html = await svc.renderInteractive('tx-1', mintInteractiveToken(cfg, 'tx-1', 'GABC'));

    expect(html).toContain(IDENTITY_FORM_TITLE);
    expect(html).not.toContain(RESTART_SENTENCE);
  });
});
