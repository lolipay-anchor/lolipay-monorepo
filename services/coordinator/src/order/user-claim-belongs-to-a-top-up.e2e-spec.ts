import { INestApplication } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { bootAuthApp } from '../auth/auth-test-helpers';
import { PrismaService } from '../prisma/prisma.service';
import { Flow } from './order.params';

describe('a WITHDRAW row cannot carry a depositor payment claim, because on a WITHDRAW the depositor does not pay (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await bootAuthApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function seedOrder(flow: Flow) {
    const person = await prisma.person.create({ data: {} });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 7200);
    return prisma.order.create({
      data: {
        personId: person.id,
        userAddress: 'GUSER00000000000000000000000000000000000000000000000000',
        flow,
        status: 'CREATED',
        tradeId: randomBytes(32).toString('hex'),
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

  it('refuses to give a WITHDRAW order a userClaimedPaidAt, and leaves the column null', async () => {
    const order = await seedOrder('WITHDRAW');

    await expect(
      prisma.order.update({ where: { id: order.id }, data: { userClaimedPaidAt: new Date() } }),
    ).rejects.toThrow(/a_user_claim_belongs_to_a_top_up/);

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.userClaimedPaidAt).toBeNull();
  });

  it('gives a TOP_UP order a userClaimedPaidAt, so the gate is not simply refusing everything', async () => {
    const order = await seedOrder('TOP_UP');

    await prisma.order.update({ where: { id: order.id }, data: { userClaimedPaidAt: new Date() } });

    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.userClaimedPaidAt).toBeInstanceOf(Date);
  });
});
