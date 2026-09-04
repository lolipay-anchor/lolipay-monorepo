import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { AppModule } from '../app.module';
import { AccountSignersService } from '../sep10/account-signers.service';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { PRICE_ADAPTER } from '../rate/rate.module';
import { ThrottlerStorage } from '@nestjs/throttler';
import { configureHttp } from '../http-setup';
import { sessionToken } from '../auth/auth-test-helpers';
import { KYC_PROVIDER } from './kyc-provider';
import { StubKycProvider } from './stub-kyc-provider';
import { invalidateAllConfigCaches } from '../config/config-cache';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

describe('with AML optional, only a verification the provider delivered opens the deposit gate', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let savedFlag: string | undefined;

  beforeAll(async () => {
    savedFlag = process.env.KYC_REQUIRE_AML;
    process.env.KYC_REQUIRE_AML = 'false';
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AccountSignersService)
      .useValue({ load: jest.fn().mockResolvedValue(null) })
      .overrideProvider(PRICE_ADAPTER)
      .useValue({ name: 'fake', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) })
      .overrideProvider(StellarReadService)
      .useValue({
        isEligible: jest.fn().mockResolvedValue(true),
        getStakeInfo: jest.fn().mockResolvedValue({ staked: '1000000000000', unbonding: '0', unbond_available_at: 0, min_stake: '1', eligible: true }),
        getTradeStatus: jest.fn().mockResolvedValue(null),
        getTradeStatusStrict: jest.fn().mockResolvedValue(null),
        hasUsdcTrustline: jest.fn().mockResolvedValue(true),
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
    const lp = await prisma.lp.create({
      data: { stellarAddress: Keypair.random().publicKey(), status: 'APPROVED', online: true, lastHeartbeatAt: new Date(), contact: 'lp@aml.test', liquidityProof: 'proof', approvedAt: new Date() },
    });
    await prisma.paymentMethod.create({ data: { lpId: lp.id, rail: 'BANK', label: 'BCA', details: 'BCA 1', active: true } });
  });

  afterAll(async () => {
    if (savedFlag === undefined) delete process.env.KYC_REQUIRE_AML;
    else process.env.KYC_REQUIRE_AML = savedFlag;
    await app.close();
  });

  async function quoteFor() {
    const kp = Keypair.random();
    const jwt = await sessionToken(app, kp);
    const q = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);
    return { jwt, quoteId: q.body.quote_id as string, address: kp.publicKey() };
  }

  async function accepted(address: string, stamps: { deliveredAt: Date | null; screenedAt: Date | null }) {
    const link = await prisma.walletLink.findUnique({ where: { stellarAddress: address } });
    await prisma.kycVerification.create({
      data: { customerRef: address, personId: link!.personId, status: 'ACCEPTED', verifiedAt: new Date(), ...stamps },
    });
  }

  it('a bare PUT /customer through the stub provider writes an acceptance nobody delivered, and the gate refuses it', async () => {
    const { jwt, quoteId, address } = await quoteFor();
    await request(app.getHttpServer())
      .put('/customer')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ first_name: 'Budi', last_name: 'Santoso', email_address: 'budi@example.com', id_type: 'id_card', id_country_code: 'IDN' })
      .expect(202);
    const row = await prisma.kycVerification.findUnique({ where: { customerRef: address } });
    expect(row?.status).toBe('ACCEPTED');
    expect(row?.deliveredAt).toBeNull();
    const res = await request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${jwt}`).send({ quoteId });
    expect(res.status).toBe(403);
  });

  it('an acceptance the provider delivered without a screening opens the gate, which is what the flag exists for', async () => {
    const { jwt, quoteId, address } = await quoteFor();
    await accepted(address, { deliveredAt: new Date(), screenedAt: null });
    await request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${jwt}`).send({ quoteId }).expect(201);
  });

  it('an acceptance screened before the delivery stamp existed still opens the gate', async () => {
    const { jwt, quoteId, address } = await quoteFor();
    await accepted(address, { deliveredAt: null, screenedAt: new Date() });
    await request(app.getHttpServer()).post('/orders').set('Authorization', `Bearer ${jwt}`).send({ quoteId }).expect(201);
  });
});
