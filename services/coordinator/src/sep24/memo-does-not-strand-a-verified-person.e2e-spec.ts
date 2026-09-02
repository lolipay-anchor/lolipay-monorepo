import { Test } from '@nestjs/testing';
import { INestApplication, ServiceUnavailableException } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { AppModule } from '../app.module';
import { AccountSignersService } from '../sep10/account-signers.service';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { PRICE_ADAPTER } from '../rate/rate.module';
import { ThrottlerStorage } from '@nestjs/throttler';
import { configureHttp } from '../http-setup';
import { anchorToken } from '../auth/auth-test-helpers';
import { KYC_PROVIDER } from '../kyc/kyc-provider';
import { StubKycProvider } from '../kyc/stub-kyc-provider';
import { invalidateAllConfigCaches } from '../config/config-cache';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

const REFUSAL = 'identity verification is required before a trade can be opened';

describe('a memo in the SEP-10 subject does not strand a person the anchor has verified', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let savedSecret: string | undefined;
  let savedEnvironment: string | undefined;

  beforeAll(async () => {
    savedSecret = process.env.DIDIT_WEBHOOK_SECRET;
    savedEnvironment = process.env.DIDIT_ENVIRONMENT;
    process.env.DIDIT_WEBHOOK_SECRET = 'example-webhook-secret-not-a-real-one';
    process.env.DIDIT_ENVIRONMENT = 'sandbox';

    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccountSignersService)
      .useValue({ load: jest.fn().mockResolvedValue(null) })
      .overrideProvider(PRICE_ADAPTER)
      .useValue({ name: 'fake', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) })
      .overrideProvider(StellarReadService)
      .useValue({
        isEligible: jest.fn().mockResolvedValue(true),
        getStakeInfo: jest.fn().mockResolvedValue({
          staked: '1000000000000', unbonding: '0', unbond_available_at: 0, min_stake: '1', eligible: true,
        }),
        getTradeStatus: jest.fn().mockResolvedValue(null),
        getTradeStatusStrict: jest.fn().mockResolvedValue(null),
        hasUsdcTrustline: jest.fn(async (address: string) => {
          if (address.includes(':')) {
            throw new ServiceUnavailableException(
              'cannot verify the USDC trustline right now — please retry in a moment',
            );
          }
          return true;
        }),
      })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .overrideProvider(KYC_PROVIDER)
      .useValue(new StubKycProvider())
      .compile();

    app = mod.createNestApplication();
    configureHttp(app);
    await app.init();
    prisma = mod.get(PrismaService);

    const settings = {
      spreadBps: 150, platformFeeBps: 30, lpFeeBps: 120,
      minOrder: 50_000_000n, maxOrder: 10_000_000_000n, paused: false,
      dailyLimitByTier: { BRONZE: 1000000, SILVER: 1000000, TRUSTED: 1000000, GOLD: 1000000 },
      payWindowSecs: 1800, confirmWindowSecs: 1800, disputeWindowSecs: 7200,
      platformWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    };
    await prisma.config.upsert({ where: { id: 1 }, update: settings, create: { id: 1, ...settings } });
    invalidateAllConfigCaches();

    await prisma.order.deleteMany({});
    await prisma.paymentMethod.deleteMany({});
    await prisma.lp.deleteMany({});
    const lpKp = Keypair.random();
    const lp = await prisma.lp.create({
      data: {
        stellarAddress: lpKp.publicKey(), status: 'APPROVED', online: true,
        lastHeartbeatAt: new Date(), contact: 'lp@memo.test', liquidityProof: 'proof',
        approvedAt: new Date(),
      },
    });
    await prisma.paymentMethod.create({
      data: { lpId: lp.id, rail: 'BANK', label: 'BCA', details: 'BCA 1', active: true },
    });
  });

  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.DIDIT_WEBHOOK_SECRET;
    else process.env.DIDIT_WEBHOOK_SECRET = savedSecret;
    if (savedEnvironment === undefined) delete process.env.DIDIT_ENVIRONMENT;
    else process.env.DIDIT_ENVIRONMENT = savedEnvironment;
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  async function depositReaching(amountFor: { sessionMemo?: string; screenedAt: 'bare' | 'memo' }) {
    const kp = Keypair.random();
    const jwt = await anchorToken(app, kp, amountFor.sessionMemo);
    const subject = amountFor.sessionMemo === undefined
      ? kp.publicKey()
      : `${kp.publicKey()}:${amountFor.sessionMemo}`;

    const opened = await http()
      .post('/sep24/transactions/deposit/interactive')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ asset_code: 'USDC' })
      .expect(200);
    const url = new URL(opened.body.url as string);
    const id = url.pathname.split('/').pop() as string;
    const token = url.searchParams.get('token') as string;

    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: kp.publicKey() } });
    await prisma.kycVerification.create({
      data: {
        customerRef: amountFor.screenedAt === 'bare' ? kp.publicKey() : `${kp.publicKey()}:2`,
        personId: link!.personId,
        status: 'ACCEPTED',
        screenedAt: new Date(),
        verifiedAt: new Date(),
      },
    });

    const first = await http().get(`/sep24/interactive/${id}?token=${token}`);
    const cookie = (first.headers['set-cookie'] as unknown as string[]) ?? [];
    const res = await http()
      .post(`/sep24/interactive/${id}/amount`)
      .set('Cookie', cookie)
      .set('Origin', 'https://api.lolipay.app')
      .send('fiat_amount=1600000');

    return { kp, id, subject, res };
  }

  it('opens a deposit for a session whose subject carries a memo the screening does not', async () => {
    const { kp, id, subject, res } = await depositReaching({ sessionMemo: '2', screenedAt: 'bare' });
    expect(res.text ?? '').not.toContain(REFUSAL);

    const tx = await prisma.sep24Transaction.findUniqueOrThrow({ where: { id } });
    expect(tx.stellarAccount).toBe(subject);
    expect(tx.orderId).not.toBeNull();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: tx.orderId as string } });
    expect(order.userAddress).toBe(kp.publicKey());

    const quote = await prisma.quote.findFirstOrThrow({ where: { userAddress: kp.publicKey() } });
    expect(quote.userAddress).toBe(kp.publicKey());
  }, 30_000);

  it('opens a deposit for a bare session whose person was screened under a memo, which is the live shape', async () => {
    const { kp, id, res } = await depositReaching({ screenedAt: 'memo' });
    expect(res.text ?? '').not.toContain(REFUSAL);

    const tx = await prisma.sep24Transaction.findUniqueOrThrow({ where: { id } });
    expect(tx.stellarAccount).toBe(kp.publicKey());
    expect(tx.orderId).not.toBeNull();

    const order = await prisma.order.findUniqueOrThrow({ where: { id: tx.orderId as string } });
    expect(order.userAddress).toBe(kp.publicKey());
  }, 30_000);
});
