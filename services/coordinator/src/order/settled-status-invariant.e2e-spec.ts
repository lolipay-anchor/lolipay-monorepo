import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Keypair, nativeToScVal } from '@stellar/stellar-sdk';
import { randomBytes } from 'crypto';
import { ThrottlerStorage } from '@nestjs/throttler';
import { AppModule } from '../app.module';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { PRICE_ADAPTER } from '../rate/rate.module';
import { IndexerService } from '../indexer/indexer.service';
import { OrderStatusService } from './order-status.service';
import { OrderService } from './order.service';
import { canDispute } from './dispute.util';

const noopStorage = {
  increment: async () => ({ totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 }),
};

describe('every path that settles an order records the direction it settled in (ADR 0045 §5, e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let indexer: any;
  let statuses: OrderStatusService;
  let orders: OrderService;
  let stellar: any;
  const escrow = process.env.ESCROW_CONTRACT_ID as string;
  const userKp = Keypair.random();
  const lpKp = Keypair.random();

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(PRICE_ADAPTER)
      .useValue({ name: 'fake', fetchPrices: jest.fn().mockResolvedValue({ IDR: '16000' }) })
      .overrideProvider(StellarReadService)
      .useValue({
        isEligible: jest.fn().mockResolvedValue(true),
        getTradeStatus: jest.fn().mockResolvedValue(null),
        getTradeStatusStrict: jest.fn().mockResolvedValue(null),
        hasUsdcTrustline: jest.fn().mockResolvedValue(true),
      })
      .overrideProvider(ThrottlerStorage)
      .useValue(noopStorage)
      .compile();
    app = mod.createNestApplication();
    await app.init();
    prisma = mod.get(PrismaService);
    indexer = mod.get(IndexerService);
    statuses = mod.get(OrderStatusService);
    orders = mod.get(OrderService);
    stellar = mod.get(StellarReadService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    stellar.getTradeStatus.mockResolvedValue(null);
    stellar.getTradeStatusStrict.mockResolvedValue(null);
  });

  async function seedFunded() {
    const person = await prisma.person.create({ data: {} });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 7200);
    return prisma.order.create({
      data: {
        personId: person.id,
        userAddress: userKp.publicKey(),
        lpWallet: lpKp.publicKey(),
        flow: 'TOP_UP',
        status: 'FUNDED',
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
      },
    });
  }

  async function ordersSettledWithoutADirection(): Promise<number> {
    const rows = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT count(*)::bigint AS count FROM "Order" WHERE status IN ('RELEASED','REFUNDED') AND "settledStatus" IS NULL`,
    );
    return Number(rows[0].count);
  }

  let violationsBefore = 0;
  beforeEach(async () => {
    violationsBefore = await ordersSettledWithoutADirection();
  });

  async function noNewViolation(): Promise<void> {
    expect(await ordersSettledWithoutADirection()).toBe(violationsBefore);
  }

  const event = (name: string, tradeId: string, value: any) => ({
    id: `inv-${name}-${tradeId.slice(0, 12)}`,
    ledger: 4_600_000,
    transactionIndex: 1,
    operationIndex: 0,
    ledgerClosedAt: new Date().toISOString(),
    topic: [nativeToScVal(name, { type: 'symbol' }), nativeToScVal(Buffer.from(tradeId, 'hex'))],
    value,
    contractId: escrow,
  });

  it('the database itself refuses a settled row with no direction, so a path nobody thought to test cannot create one', async () => {
    const order = await seedFunded();

    await expect(
      prisma.order.update({ where: { id: order.id }, data: { status: 'RELEASED' } }),
    ).rejects.toThrow(/settled_rows_record_a_direction/);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('FUNDED');
    await noNewViolation();
  });

  it('the indexer records it when a settlement event advances the order', async () => {
    const order = await seedFunded();

    expect(await indexer.applyEvent(event('released', order.tradeId, nativeToScVal(null)))).toBe(1);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('RELEASED');
    expect(after.settledStatus).toBe('RELEASED');
    await noNewViolation();
  });

  it('the indexer records it when a pre-settlement verdict settles the order', async () => {
    const order = await seedFunded();
    await prisma.order.update({ where: { id: order.id }, data: { status: 'DISPUTED' } });

    expect(
      await indexer.applyEvent(
        event('resolved', order.tradeId, nativeToScVal({ released: false, post_settle: false })),
      ),
    ).toBe(1);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('REFUNDED');
    expect(after.settledStatus).toBe('REFUNDED');
    await noNewViolation();
  });

  it('the indexer records it when a post-settlement verdict is the first thing to settle the row', async () => {
    const order = await seedFunded();
    await prisma.order.update({ where: { id: order.id }, data: { status: 'DISPUTED' } });
    const settledAtSecs = Math.floor(Date.now() / 1000);
    stellar.getTradeStatusStrict.mockResolvedValue({
      status: 'RELEASED',
      settledAt: settledAtSecs,
      postSettleDeadline: BigInt(settledAtSecs + 3600),
      liabilityEstablished: true,
      slashDeadline: settledAtSecs + 86_400,
    });

    expect(
      await indexer.applyEvent(
        event('resolved', order.tradeId, nativeToScVal({ released: true, post_settle: true })),
      ),
    ).toBe(1);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('RELEASED');
    expect(after.settledStatus).toBe('RELEASED');
    expect(after.settledAt).toBeInstanceOf(Date);
    expect(after.postSettleDeadline).not.toBeNull();
    expect(canDispute({ ...after, status: after.status as string }, { postSettleDisputeWindowSecs: 3600 })).toBe(true);
    await noNewViolation();
  });

  it('the cancel path records it when the chain settled the order under a cancel attempt', async () => {
    const order = await seedFunded();
    const settledAt = Math.floor(Date.now() / 1000);
    stellar.getTradeStatusStrict.mockResolvedValue({
      status: 'RELEASED',
      settledAt,
      usdcAmount: order.usdcAmount,
      fiatAmount: order.fiatAmount,
      usdcRecipient: userKp.publicKey(),
      postSettleDeadline: BigInt(settledAt + 3600),
    });

    await orders.cancelOrder(order.id, userKp.publicKey()).catch(() => undefined);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('RELEASED');
    expect(after.settledStatus).toBe('RELEASED');
    await noNewViolation();
  });

  it('the order page records it when the chain settled the order before any event was indexed', async () => {
    const order = await seedFunded();
    stellar.getTradeStatus.mockResolvedValue({
      status: 'RELEASED',
      settledAt: Math.floor(Date.now() / 1000),
      usdcAmount: order.usdcAmount,
      fiatAmount: order.fiatAmount,
      usdcRecipient: userKp.publicKey(),
      postSettleDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });

    await statuses.refreshOrderStatus(order.id, order);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe('RELEASED');
    expect(after.settledStatus).toBe('RELEASED');
    await noNewViolation();
  });
});
