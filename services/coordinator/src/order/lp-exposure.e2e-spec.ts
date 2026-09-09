import { PrismaService } from '../prisma/prisma.service';
import { lpExposure } from './lp-exposure';

const NOW = 1_800_000_000;

describe('an LP is exposed on a trade for as long as it can still be slashed for it', () => {
  const prisma = new PrismaService();
  let lpId: string;
  let personId: string;

  beforeAll(async () => {
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    const person = await prisma.person.create({ data: {} });
    personId = person.id;
    const lp = await prisma.lp.create({
      data: {
        stellarAddress: `G${Math.random().toString(36).slice(2)}${Date.now()}`,
        status: 'APPROVED',
        contact: 'lp@example.test',
        liquidityProof: 'proof',
      },
    });
    lpId = lp.id;
  });

  async function order(patch: Record<string, unknown>) {
    return prisma.order.create({
      data: {
        tradeId: `${Date.now()}${Math.random().toString(36).slice(2)}`,
        userAddress: 'GUSER',
        personId,
        lpId,
        flow: 'WITHDRAW',
        rail: 'BANK',
        usdcAmount: 100n,
        fiatAmount: 1_600_000n,
        rateSnapshot: '16000',
        platformFeeBps: 10,
        lpFeeBps: 10,
        platformWallet: 'GPLATFORM',
        payDeadline: BigInt(NOW),
        confirmDeadline: BigInt(NOW),
        disputeDeadline: BigInt(NOW),
        expiresAt: new Date(NOW * 1000),
        ...patch,
        ...(patch.status === 'RELEASED' || patch.status === 'REFUNDED' ? { settledStatus: patch.status } : {}),
      } as any,
    });
  }

  it('still counts a settled trade that was disputed after the raise window closed', async () => {
    await order({
      status: 'DISPUTED',
      settledAt: new Date((NOW - 7200) * 1000),
      postSettleDeadline: BigInt(NOW - 60),
      slashDeadline: null,
    });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(100n);
  });

  it('stops counting a withdrawal once its post-settlement window has closed', async () => {
    await order({
      status: 'RELEASED',
      settledAt: new Date((NOW - 7200) * 1000),
      postSettleDeadline: BigInt(NOW - 60),
      slashDeadline: null,
    });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(0n);
  });

  it('still counts a withdrawal while its post-settlement window is open', async () => {
    await order({
      status: 'RELEASED',
      settledAt: new Date((NOW - 60) * 1000),
      postSettleDeadline: BigInt(NOW + 3600),
      slashDeadline: null,
    });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(100n);
  });

  it('frees the bond the moment a top-up is released, because the user holds the money', async () => {
    await order({
      flow: 'TOP_UP',
      status: 'RELEASED',
      settledAt: new Date(NOW * 1000),
      postSettleDeadline: BigInt(NOW + 86_400),
    });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(0n);
  });

  it('holds the bond on a refunded top-up, because the provider gets the money back', async () => {
    await order({
      flow: 'TOP_UP',
      status: 'REFUNDED',
      settledAt: new Date(NOW * 1000),
      postSettleDeadline: BigInt(NOW + 86_400),
    });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(100n);
  });

  it('frees the bond on a refunded withdrawal, because the user holds the money', async () => {
    await order({
      status: 'REFUNDED',
      settledAt: new Date(NOW * 1000),
      postSettleDeadline: BigInt(NOW + 86_400),
    });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(0n);
  });

  it('counts a settled order that carries no deadline at all rather than treating it as free', async () => {
    await order({
      status: 'RELEASED',
      settledAt: new Date((NOW - 86_400) * 1000),
      postSettleDeadline: null,
      slashDeadline: null,
    });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(100n);
  });

  it('counts on the recorded slash deadline when it outlasts the derived one', async () => {
    await order({
      status: 'RELEASED',
      settledAt: new Date((NOW - 7200) * 1000),
      postSettleDeadline: BigInt(NOW - 3600),
      slashDeadline: BigInt(NOW + 600),
      liabilityEstablished: true,
    });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(100n);
  });

  it('counts an unfunded order past its expiry, because only the sweep knows it never reached the chain', async () => {
    await order({
      status: 'MATCHED',
      expiresAt: new Date((NOW - 3600) * 1000),
    });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(100n);
  });

  it('ignores orders the LP has walked away from', async () => {
    await order({ status: 'EXPIRED' });
    await order({ status: 'CANCELLED' });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(0n);
  });

  it('adds up every live trade, and only this provider\'s', async () => {
    await order({ status: 'FUNDED', usdcAmount: 40n });
    await order({ status: 'FIAT_PAID', usdcAmount: 60n });
    const other = await prisma.lp.create({
      data: {
        stellarAddress: `G${Math.random().toString(36).slice(2)}${Date.now()}x`,
        status: 'APPROVED',
        contact: 'other@example.test',
        liquidityProof: 'proof',
      },
    });
    await order({ status: 'FUNDED', usdcAmount: 999n, lpId: other.id });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(100n);
  });

  it('keeps counting a trade whose verdict landed while the row was read back as released', async () => {
    await order({
      status: 'RELEASED',
      settledAt: new Date((NOW - 90_000) * 1000),
      postSettleDeadline: BigInt(NOW - 3600),
      disputeAt: new Date((NOW - 7200) * 1000),
      slashDeadline: null,
    });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(100n);
  });

  it('does not treat a closed slash window as final once the trade is disputed again', async () => {
    await order({
      status: 'DISPUTED',
      settledAt: new Date((NOW - 7200) * 1000),
      postSettleDeadline: BigInt(NOW - 60),
      disputeAt: new Date((NOW - 60) * 1000),
      slashDeadline: 0n,
    });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(100n);
  });

  it('lets go of a settlement with no recorded deadline once no slash window could still be open', async () => {
    await order({
      status: 'RELEASED',
      settledAt: new Date((NOW - 345_601) * 1000),
      postSettleDeadline: null,
      slashDeadline: null,
    });

    expect(await lpExposure(prisma, lpId, NOW)).toBe(0n);
  });
});
