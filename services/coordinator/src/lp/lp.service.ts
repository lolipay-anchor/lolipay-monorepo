import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { OrderStatus, Prisma, Rail } from '@prisma/client';
import { applyBps, baseUnitsToUsdc } from '../money/money';

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface LpEarningsDayBar {
  date: string;
  volumeUsdc: number;
  earnedUsdc: number;
}

export interface LpEarnings {
  todayTrades: number;
  todayEarnedUsdc: number;
  todayVolumeUsdc: number;
  weekBars: LpEarningsDayBar[];
  allTimeTrades: number;
  allTimeEarnedUsdc: number;
}

@Injectable()
export class LpService {
  constructor(
    private prisma: PrismaService,
    private stellar: StellarReadService,
  ) {}

  async apply(address: string, contact: string, liquidityProof: string) {
    const existing = await this.prisma.lp.findUnique({
      where: { stellarAddress: address },
    });
    if (existing && (existing.status === 'SUSPENDED' || existing.status === 'REVOKED')) {
      throw new ConflictException(
        'This wallet is not eligible to apply. Contact support if you believe this is a mistake.',
      );
    }

    const hasTrustline = await this.stellar.hasUsdcTrustline(address);
    if (!hasTrustline) {
      throw new BadRequestException(
        'Add a USDC trustline to your wallet before applying as an LP — you need it to receive USDC.',
      );
    }

    if (existing) {
      return this.prisma.lp.update({
        where: { stellarAddress: address },
        data: { contact, liquidityProof, status: 'PENDING', approvedAt: null },
      });
    }

    return this.prisma.lp.create({
      data: { stellarAddress: address, contact, liquidityProof },
    });
  }

  me(address: string) {
    return this.prisma.lp.findUnique({
      where: { stellarAddress: address },
      select: {
        id: true,
        stellarAddress: true,
        status: true,
        contact: true,
        liquidityProof: true,
        online: true,
        lastHeartbeatAt: true,
        createdAt: true,
        approvedAt: true,
        paymentMethods: true,
      },
    });
  }

  async heartbeat(address: string) {
    await this.prisma.lp.update({
      where: { stellarAddress: address },
      data: { lastHeartbeatAt: new Date() },
    });
  }

  async setAvailability(address: string, available: boolean) {
    await this.prisma.lp.update({
      where: { stellarAddress: address },
      data: { online: available },
    });
  }

  async addPaymentMethod(lpAddress: string, rail: Rail, label: string, details: string) {
    const lp = await this.prisma.lp.findUnique({ where: { stellarAddress: lpAddress } });
    if (!lp) throw new NotFoundException('LP not found');

    return this.prisma.paymentMethod.create({
      data: { lpId: lp.id, rail, label, details },
    });
  }

  async updatePaymentMethod(
    lpAddress: string,
    id: string,
    patch: { rail?: Rail; label?: string; details?: string; active?: boolean },
  ) {
    const existing = await this.prisma.paymentMethod.findFirst({
      where: { id, lp: { stellarAddress: lpAddress } },
    });
    if (!existing) throw new NotFoundException('Payment method not found');

    const data: Record<string, unknown> = {};
    if (patch.rail !== undefined) data['rail'] = patch.rail;
    if (patch.label !== undefined) data['label'] = patch.label;
    if (patch.details !== undefined) data['details'] = patch.details;
    if (patch.active !== undefined) data['active'] = patch.active;
    return this.prisma.paymentMethod.update({ where: { id }, data });
  }

  async deletePaymentMethod(lpAddress: string, id: string) {
    const existing = await this.prisma.paymentMethod.findFirst({
      where: { id, lp: { stellarAddress: lpAddress } },
    });
    if (!existing) throw new NotFoundException('Payment method not found');
    await this.prisma.paymentMethod.delete({ where: { id } });
  }

  async buildStakeTx(
    lpAddress: string,
    amount: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    try {
      return await this.stellar.buildStakeTx(lpAddress, amount);
    } catch (err: unknown) {
      console.error('buildStakeTx RPC error:', err instanceof Error ? err.message : String(err));
      throw new ServiceUnavailableException('Stellar RPC unavailable, retry later');
    }
  }

  async buildRequestUnstakeTx(
    lpAddress: string,
    amount: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    try {
      return await this.stellar.buildRequestUnstakeTx(lpAddress, amount);
    } catch (err: unknown) {
      console.error('buildRequestUnstakeTx RPC error:', err instanceof Error ? err.message : String(err));
      throw new ServiceUnavailableException('Stellar RPC unavailable, retry later');
    }
  }

  async buildClaimUnstakeTx(
    lpAddress: string,
  ): Promise<{ xdr: string; networkPassphrase: string }> {
    try {
      return await this.stellar.buildClaimUnstakeTx(lpAddress);
    } catch (err: unknown) {
      console.error('buildClaimUnstakeTx RPC error:', err instanceof Error ? err.message : String(err));
      throw new ServiceUnavailableException('Stellar RPC unavailable, retry later');
    }
  }

  async getStakeInfo(lpAddress: string): Promise<{
    staked: string;
    unbonding: string;
    unbond_available_at: number;
    min_stake: string;
    eligible: boolean;
  }> {
    try {
      return await this.stellar.getStakeInfo(lpAddress);
    } catch (err: unknown) {
      console.error('getStakeInfo RPC error:', err instanceof Error ? err.message : String(err));
      throw new ServiceUnavailableException('Stellar RPC unavailable, retry later');
    }
  }

  async getEarnings(address: string): Promise<LpEarnings> {
    const lp = await this.prisma.lp.findUnique({ where: { stellarAddress: address } });

    if (!lp) throw new NotFoundException('LP not found');

    const todayStart = startOfUtcDay(new Date());
    const weekStart = new Date(todayStart.getTime() - 6 * DAY_MS);

    const [todayRows, weekRowsRaw, allTimeTrades, allTimeEarnedRaw] = await Promise.all([
      this.prisma.order.findMany({
        where: { lpId: lp.id, status: OrderStatus.RELEASED, settledAt: { gte: todayStart } },
        select: { usdcAmount: true, lpFeeBps: true },
      }),
      this.prisma.$queryRaw<{ day: string; volume: string; earned: string }[]>(Prisma.sql`
        SELECT to_char(date_trunc('day', "settledAt"), 'YYYY-MM-DD') AS day,
               SUM("usdcAmount")::text AS volume,
               SUM(("usdcAmount" * "lpFeeBps") / 10000)::text AS earned
        FROM "Order"
        WHERE "lpId" = ${lp.id} AND status = 'RELEASED' AND "settledAt" >= ${weekStart}
        GROUP BY day
        ORDER BY day ASC
      `),
      this.prisma.order.count({ where: { lpId: lp.id, status: OrderStatus.RELEASED } }),
      this.prisma.$queryRaw<{ earned: string | null }[]>(Prisma.sql`
        SELECT SUM(("usdcAmount" * "lpFeeBps") / 10000)::text AS earned
        FROM "Order"
        WHERE "lpId" = ${lp.id} AND status = 'RELEASED'
      `),
    ]);

    let todayVolumeBase = 0n;
    let todayEarnedBase = 0n;
    for (const o of todayRows) {
      todayVolumeBase += o.usdcAmount;
      todayEarnedBase += applyBps(o.usdcAmount, o.lpFeeBps);
    }

    const byDay = new Map(weekRowsRaw.map((r) => [r.day, r]));
    const weekBars: LpEarningsDayBar[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(todayStart.getTime() - i * DAY_MS);
      const key = utcDateStr(d);
      const row = byDay.get(key);
      weekBars.push({
        date: key,
        volumeUsdc: row ? baseUnitsToUsdc(BigInt(row.volume)) : 0,
        earnedUsdc: row ? baseUnitsToUsdc(BigInt(row.earned)) : 0,
      });
    }

    const allTimeEarnedBase = BigInt(allTimeEarnedRaw[0]?.earned ?? '0');

    return {
      todayTrades: todayRows.length,
      todayEarnedUsdc: baseUnitsToUsdc(todayEarnedBase),
      todayVolumeUsdc: baseUnitsToUsdc(todayVolumeBase),
      weekBars,
      allTimeTrades,
      allTimeEarnedUsdc: baseUnitsToUsdc(allTimeEarnedBase),
    };
  }

  async assignableLps(rail: Rail) {
    return this.prisma.lp.findMany({
      where: {
        status: 'APPROVED',
        online: true,
        paymentMethods: { some: { rail, active: true } },
      },
      include: { paymentMethods: { where: { rail, active: true } } },
    });
  }
}
