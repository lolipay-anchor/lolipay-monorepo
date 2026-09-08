import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { Keypair, nativeToScVal } from '@stellar/stellar-sdk';
import { createHash, randomBytes } from 'crypto';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { PRICE_ADAPTER } from '../rate/rate.module';
import { IndexerService } from './indexer.service';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

function signChallenge(kp: Keypair, message: string): string {
  const payload = Buffer.concat([Buffer.from('Stellar Signed Message:\n', 'utf8'), Buffer.from(message, 'utf8')]);
  const hash = createHash('sha256').update(payload).digest();
  return Buffer.from(kp.sign(hash)).toString('base64');
}

async function mintJwt(app: INestApplication, kp: Keypair): Promise<string> {
  const ch = await request(app.getHttpServer()).post('/auth/challenge').send({ address: kp.publicKey() }).expect(201);
  const nonce = ch.body.nonce as string;
  const res = await request(app.getHttpServer())
    .post('/auth/verify')
    .send({ address: kp.publicKey(), nonce, signature: signChallenge(kp, nonce) })
    .expect(201);
  return res.body.jwt as string;
}

describe('a verdict closes the dispute round on the real database (ADR 0043, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let indexer: any;
  let stellar: any;
  const escrow = process.env.ESCROW_CONTRACT_ID as string;
  const userKp = Keypair.random();
  const lpKp = Keypair.random();
  const FILED_AT = new Date(Date.now() - 3_600_000);
  const fakeAdapter = { name: 'fake', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PRICE_ADAPTER)
      .useValue(fakeAdapter)
      .overrideProvider(StellarReadService)
      .useValue({
        isEligible: jest.fn().mockResolvedValue(true),
        getStakeInfo: jest.fn().mockResolvedValue({ staked: '1000000000000', unbonding: '0', unbond_available_at: 0, min_stake: '1', eligible: true }),
        getTradeStatus: jest.fn().mockResolvedValue(null),
        getTradeStatusStrict: jest.fn().mockResolvedValue(null),
        hasUsdcTrustline: jest.fn().mockResolvedValue(true),
        buildRaiseDisputeTx: jest.fn().mockResolvedValue({ xdr: 'raise-dispute-xdr', networkPassphrase: 'Test SDF Network ; September 2015' }),
      })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .compile();
    app = mod.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
    prisma = mod.get(PrismaService);
    indexer = mod.get(IndexerService);
    stellar = mod.get(StellarReadService);
    await prisma.config.upsert({
      where: { id: 1 },
      update: { postSettleDisputeWindowSecs: 3600, paused: false },
      create: {
        id: 1,
        spreadBps: 150,
        platformFeeBps: 30,
        lpFeeBps: 120,
        minOrder: 50_000_000n,
        maxOrder: 10_000_000_000n,
        paused: false,
        dailyLimitByTier: { BRONZE: 1000000, SILVER: 1000000, TRUSTED: 1000000, GOLD: 1000000 },
        payWindowSecs: 1800,
        confirmWindowSecs: 1800,
        disputeWindowSecs: 7200,
        postSettleDisputeWindowSecs: 3600,
        requireProof: false,
        platformWallet: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    stellar.getTradeStatusStrict.mockResolvedValue(null);
  });

  async function seedDisputedOrder() {
    const person = await prisma.person.create({ data: {} });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 7200);
    return prisma.order.create({
      data: {
        personId: person.id,
        userAddress: userKp.publicKey(),
        lpWallet: lpKp.publicKey(),
        flow: 'TOP_UP',
        status: 'DISPUTED',
        tradeId: randomBytes(32).toString('hex'),
        contractId: escrow,
        usdcAmount: 10_0000000n,
        fiatAmount: 1_600_000n,
        rail: 'BANK',
        rateSnapshot: '16000',
        platformFeeBps: 30,
        lpFeeBps: 20,
        platformWallet: 'GPLATFORM',
        payDeadline: deadline,
        confirmDeadline: deadline,
        disputeDeadline: deadline,
        expiresAt: new Date(Date.now() + 1_800_000),
        disputeBy: 'user',
        disputeReason: 'USDC_NOT_RELEASED',
        disputeNote: 'nothing arrived',
        disputeAt: FILED_AT,
        onChainDisputedBy: userKp.publicKey(),
      },
    });
  }

  async function seedChainRaisedOrder() {
    const order = await seedDisputedOrder();
    return prisma.order.update({
      where: { id: order.id },
      data: { disputeBy: null, disputeReason: null, disputeNote: null, onChainDisputedBy: lpKp.publicKey(), resolverDisputed: true },
    });
  }

  const verdictFor = (tradeId: string) => ({
    id: `pre-${tradeId.slice(0, 16)}`,
    topic: [nativeToScVal('resolved', { type: 'symbol' }), nativeToScVal(Buffer.from(tradeId, 'hex'))],
    value: nativeToScVal({ released: true, post_settle: false }),
    contractId: escrow,
  });

  const postSettleVerdictFor = (tradeId: string, released: boolean) => ({
    id: `post-${tradeId.slice(0, 16)}`,
    topic: [nativeToScVal('resolved', { type: 'symbol' }), nativeToScVal(Buffer.from(tradeId, 'hex'))],
    value: nativeToScVal({ released, post_settle: true }),
    contractId: escrow,
  });

  const ROUND_ONE_CLOSED = new Date(Date.now() - 1_800_000);

  async function seedSettledOrderWithASecondRoundOpen(round2FiledBy: string) {
    const order = await seedDisputedOrder();
    return prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'RELEASED',
        resolution: 'released',
        settledAt: ROUND_ONE_CLOSED,
        disputeClosedAt: ROUND_ONE_CLOSED,
        disputeBy: round2FiledBy,
        disputeReason: 'USDC_NOT_RELEASED',
        disputeNote: 'the money never arrived after the release',
        disputeAt: FILED_AT,
        onChainDisputedBy: round2FiledBy === 'user' ? userKp.publicKey() : lpKp.publicKey(),
      },
    });
  }

  it('closes a round the chain raised with no filing on record, and clears the resolver marker with it', async () => {
    const order = await seedChainRaisedOrder();

    expect(await indexer.applyEvent(verdictFor(order.tradeId))).toBe(1);

    const closed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(closed).toMatchObject({ status: 'RELEASED', onChainDisputedBy: null, disputeBy: null, resolverDisputed: false });
    expect(closed.disputeClosedAt).toBeInstanceOf(Date);
    const audits = await prisma.adminAudit.findMany({ where: { targetId: order.id, action: 'order.disputeRoundClosed' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].before).toMatchObject({ disputeBy: null, onChainDisputedBy: lpKp.publicKey() });
  });

  it('leaves a round filed after the verdict alone when the same event is replayed', async () => {
    const order = await seedDisputedOrder();
    expect(await indexer.applyEvent(verdictFor(order.tradeId))).toBe(1);
    const reopened = await prisma.order.update({
      where: { id: order.id },
      data: { status: 'DISPUTED', disputeBy: 'lp', disputeReason: 'FAKE_PROOF', disputeNote: 'filed after the verdict', onChainDisputedBy: lpKp.publicKey() },
    });

    expect(await indexer.applyEvent(verdictFor(order.tradeId))).toBe(0);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after).toMatchObject({ status: 'DISPUTED', disputeBy: 'lp', disputeNote: 'filed after the verdict' });
    expect(after.disputeClosedAt?.getTime()).toBe(reopened.disputeClosedAt?.getTime());
    expect(await prisma.adminAudit.count({ where: { targetId: order.id, action: 'order.disputeRoundClosed' } })).toBe(1);
  });

  it('clears the filing, keeps its time, sets the marker, writes one audit row, ignores a replay, and lets the party file again', async () => {
    const order = await seedDisputedOrder();

    expect(await indexer.applyEvent(verdictFor(order.tradeId))).toBe(1);

    const closed = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(closed).toMatchObject({
      status: 'RELEASED',
      resolution: 'released',
      disputeBy: null,
      disputeReason: null,
      disputeNote: null,
      onChainDisputedBy: null,
    });
    expect(closed.disputeAt?.getTime()).toBe(FILED_AT.getTime());
    expect(closed.disputeClosedAt).toBeInstanceOf(Date);

    const audits = await prisma.adminAudit.findMany({ where: { targetId: order.id, action: 'order.disputeRoundClosed' } });
    expect(audits).toHaveLength(1);
    expect(audits[0].actorAddress).toBe(escrow);
    expect(audits[0].before).toMatchObject({
      disputeBy: 'user',
      disputeReason: 'USDC_NOT_RELEASED',
      disputeNote: 'nothing arrived',
      onChainDisputedBy: userKp.publicKey(),
      disputeAt: FILED_AT.toISOString(),
    });

    expect(await indexer.applyEvent(verdictFor(order.tradeId))).toBe(0);
    expect(await prisma.adminAudit.count({ where: { targetId: order.id, action: 'order.disputeRoundClosed' } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).disputeClosedAt?.getTime()).toBe(
      closed.disputeClosedAt?.getTime(),
    );

    const jwt = await mintJwt(app, userKp);
    const before = Date.now();
    const res = await request(app.getHttpServer())
      .post(`/orders/${order.id}/dispute`)
      .set('Authorization', `Bearer ${jwt}`)
      .send({ reason: 'USDC_NOT_RELEASED', note: 'still nothing after the verdict' });
    expect(res.status).toBeLessThan(300);
    expect(res.body.order.dispute_by).toBe('user');
    expect(new Date(res.body.order.dispute_at).getTime()).toBeGreaterThanOrEqual(before);
    expect(res.body.dispute_tx.xdr).toBe('raise-dispute-xdr');
  });

  it('records a post-settlement verdict that reverses the first one, even though the order page already advanced the row', async () => {
    const order = await seedSettledOrderWithASecondRoundOpen('user');
    stellar.getTradeStatusStrict.mockResolvedValue({
      status: 'REFUNDED',
      settledAt: Math.floor(Date.now() / 1000),
      liabilityEstablished: true,
      slashDeadline: Math.floor(Date.now() / 1000) + 86_400,
      postSettleDeadline: 0,
    });

    expect(await indexer.applyEvent(postSettleVerdictFor(order.tradeId, false))).toBe(1);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after).toMatchObject({
      status: 'REFUNDED',
      resolution: 'refunded',
      liabilityEstablished: true,
      disputeBy: null,
      disputeReason: null,
      disputeNote: null,
      onChainDisputedBy: null,
    });
    expect(after.disputeClosedAt!.getTime()).toBeGreaterThan(ROUND_ONE_CLOSED.getTime());
    expect(
      await prisma.adminAudit.count({ where: { targetId: order.id, action: 'order.disputeRoundClosed' } }),
    ).toBe(1);
  });

  it('refuses a post-settlement verdict it has already applied, so an event replayed on a cold start cannot close the round opened after it', async () => {
    const order = await seedDisputedOrder();
    stellar.getTradeStatusStrict.mockResolvedValue({
      status: 'RELEASED',
      settledAt: Math.floor(Date.now() / 1000),
      liabilityEstablished: false,
      slashDeadline: 0,
      postSettleDeadline: 0,
    });
    const event = postSettleVerdictFor(order.tradeId, true);

    expect(await indexer.applyEvent(event)).toBe(1);
    const settled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(settled).toMatchObject({ status: 'RELEASED', resolution: 'released', disputeBy: null });

    const refiled = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'DISPUTED',
        disputeBy: 'lp',
        disputeReason: 'FAKE_PROOF',
        disputeNote: 'filed after the verdict landed',
        onChainDisputedBy: lpKp.publicKey(),
      },
    });

    expect(await indexer.applyEvent(event)).toBe(0);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after).toMatchObject({
      status: 'DISPUTED',
      disputeBy: 'lp',
      disputeNote: 'filed after the verdict landed',
      onChainDisputedBy: lpKp.publicKey(),
    });
    expect(after.disputeClosedAt!.getTime()).toBe(refiled.disputeClosedAt!.getTime());
    expect(
      await prisma.adminAudit.count({ where: { targetId: order.id, action: 'order.disputeRoundClosed' } }),
    ).toBe(1);
  });
});
