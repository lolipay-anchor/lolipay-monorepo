import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'crypto';
import { AppModule } from '../app.module';
import { PRICE_ADAPTER } from './rate.module';
import { PrismaService } from '../prisma/prisma.service';
import { ThrottlerStorage } from '@nestjs/throttler';
import { OrderService } from '../order/order.service';
import { RateService } from '../rate/rate.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { invalidateAllConfigCaches } from '../config/config-cache';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

function signChallenge(kp: Keypair, message: string): string {
  const payload = Buffer.concat([
    Buffer.from('Stellar Signed Message:\n', 'utf8'),
    Buffer.from(message, 'utf8'),
  ]);
  const hash = createHash('sha256').update(payload).digest();
  return Buffer.from(kp.sign(hash)).toString('base64');
}

async function getJwt(app: INestApplication): Promise<{ jwt: string; address: string }> {
  const kp = Keypair.random();
  const ch = await request(app.getHttpServer())
    .post('/auth/challenge')
    .send({ address: kp.publicKey() })
    .expect(201);
  const nonce = ch.body.nonce as string;
  const sig = signChallenge(kp, nonce);
  const res = await request(app.getHttpServer())
    .post('/auth/verify')
    .send({ address: kp.publicKey(), nonce, signature: sig })
    .expect(201);
  return { jwt: res.body.jwt as string, address: kp.publicKey() };
}

describe('POST /quotes (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let clearConfigCaches: () => void;

  const fakeAdapter = {
    name: 'fake',
    fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }),
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })

      .overrideProvider(PRICE_ADAPTER)
      .useValue(fakeAdapter)

      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .compile();

    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();

    prisma = mod.get(PrismaService);

    clearConfigCaches = () => invalidateAllConfigCaches();


    jest.spyOn(mod.get(StellarReadService), 'hasUsdcTrustline').mockResolvedValue(true);

    await prisma.config.upsert({
      where: { id: 1 },
      update: {
        spreadBps: 150,
        platformFeeBps: 30,
        lpFeeBps: 120,
        minOrder: 50_000_000n,
        maxOrder: 10_000_000_000n,
        paused: false,
        dailyLimitByTier: { BRONZE: 1000000, SILVER: 1000000, TRUSTED: 1000000, GOLD: 1000000 },
      },
      create: {
        id: 1,
        spreadBps: 150,
        platformFeeBps: 30,
        lpFeeBps: 120,
        minOrder: 50_000_000n,
        maxOrder: 10_000_000_000n,
        paused: false,
        dailyLimitByTier: { BRONZE: 1000000, SILVER: 1000000, TRUSTED: 1000000, GOLD: 1000000 },
        platformWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('authenticated POST /quotes returns quote_id and fiat_amount', async () => {
    const { jwt } = await getJwt(app);

    const res = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(201);

    expect(typeof res.body.quote_id).toBe('string');
    expect(res.body.quote_id.length).toBeGreaterThan(0);

    expect(res.body.fiat_amount).toBe('1624000');
    expect(res.body.rate).toBe('16000');
    expect(res.body.platform_fee_bps).toBe(30);
    expect(res.body.lp_fee_bps).toBe(120);
    expect(typeof res.body.expires_at).toBe('string');
  });

  it('unauthenticated request → 401', async () => {
    await request(app.getHttpServer())
      .post('/quotes')
      .send({ flow: 'TOP_UP', usdcAmount: '1000000000' })
      .expect(401);
  });

  it('amount below minOrder → 400', async () => {
    const { jwt } = await getJwt(app);

    await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: '10000000' })
      .expect(400);
  });

  it('amount above maxOrder → 400', async () => {
    const { jwt } = await getJwt(app);

    await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: '10010000000' })
      .expect(400);
  });

  it('paused platform → 503', async () => {
    await prisma.config.update({ where: { id: 1 }, data: { paused: true } });
    clearConfigCaches();

    const { jwt } = await getJwt(app);
    await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(503);

    await prisma.config.update({ where: { id: 1 }, data: { paused: false } });
    clearConfigCaches();
  });

  it('invalid flow → 400', async () => {
    const { jwt } = await getJwt(app);
    await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'INVALID', rail: 'BANK', usdcAmount: '1000000000' })
      .expect(400);
  });

  it('missing rail → 400', async () => {
    const { jwt } = await getJwt(app);
    await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', usdcAmount: '1000000000' })
      .expect(400);
  });

  it('invalid rail → 400', async () => {
    const { jwt } = await getJwt(app);
    await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', rail: 'WIRE', usdcAmount: '1000000000' })
      .expect(400);
  });

  it('non-numeric usdcAmount → 400', async () => {
    const { jwt } = await getJwt(app);
    await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: 'not-a-number' })
      .expect(400);
  });

  it('zero usdcAmount → 400 (rejected at DTO layer)', async () => {
    const { jwt } = await getJwt(app);
    await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: '0' })
      .expect(400);
  });

  it('leading-zero usdcAmount → 400 (rejected at DTO layer)', async () => {
    const { jwt } = await getJwt(app);
    await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: '01000000000' })
      .expect(400);
  });

  it('client-supplied fiat_amount is ignored (server computes it)', async () => {
    const { jwt } = await getJwt(app);

    const res = await request(app.getHttpServer())
      .post('/quotes')
      .set('Authorization', `Bearer ${jwt}`)
      .send({ flow: 'TOP_UP', rail: 'BANK', usdcAmount: '1000000000', fiat_amount: '9999999' })
      .expect(201);

    expect(res.body.fiat_amount).toBe('1624000');
  });

  it('UpdateConfigDto no longer declares manualRateOverride (retired to Market — Phase 4 Task 5)', () => {
    const { plainToInstance } = require('class-transformer');
    const { validateSync } = require('class-validator');
    const { UpdateConfigDto } = require('../admin/dto/update-config.dto');
    const instance: any = plainToInstance(UpdateConfigDto, { manualRateOverride: 'not-a-number' });
    const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true });
    const err = errors.find((e: any) => e.property === 'manualRateOverride');
    expect(err).toBeDefined();
    expect(err.constraints).toMatchObject({
      whitelistValidation: 'property manualRateOverride should not exist',
    });
  });
});
