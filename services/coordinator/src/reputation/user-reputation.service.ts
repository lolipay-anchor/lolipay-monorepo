import { Injectable, Logger, OnModuleInit, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PersonId, PersonService } from '../person/person.service';
import { USER_LOST_WHERE } from './dispute-outcome';

type OrderQueryable = PrismaService | Prisma.TransactionClient;

export const TIER_LEVELS = ['BRONZE', 'SILVER', 'TRUSTED', 'GOLD'] as const;
export type UserTierName = (typeof TIER_LEVELS)[number];

const TIER_THRESHOLDS: { SILVER: number; TRUSTED: number; GOLD: number } = {
  SILVER: 5,
  TRUSTED: 20,
  GOLD: 50,
};

const DEFAULT_DAILY_LIMIT_USDC: Record<UserTierName, number> = {
  BRONZE: 100,
  SILVER: 300,
  TRUSTED: 600,
  GOLD: 2000,
};

const USDC_BASE_UNITS = 10_000_000n;

const VOLUME_EXCLUDED_STATUSES = ['EXPIRED', 'CANCELLED', 'REFUNDED'] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UserReputation {
  tier: UserTierName;
  completedTrades: number;
  disputesLost: number;
  completionRate: number | null;
}

@Injectable()
export class UserReputationService implements OnModuleInit {
  private readonly logger = new Logger(UserReputationService.name);

  constructor(
    private prisma: PrismaService,
    private people: PersonService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.backfillDisputesLost();
    } catch (err) {
      this.logger.warn(
        `reputation backfill failed at boot — continuing without it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  computeTier(completedTrades: number, disputesLost: number): UserTierName {
    let level = 0;
    if (completedTrades >= TIER_THRESHOLDS.GOLD) level = 3;
    else if (completedTrades >= TIER_THRESHOLDS.TRUSTED) level = 2;
    else if (completedTrades >= TIER_THRESHOLDS.SILVER) level = 1;

    const lost = Number.isFinite(disputesLost) && disputesLost > 0 ? Math.trunc(disputesLost) : 0;
    level = Math.max(0, level - lost);
    return TIER_LEVELS[level];
  }

  async personIdFor(address: string): Promise<PersonId> {
    try {
      const person = await this.people.lookupPerson(address);
      if (!person?.id) throw new Error('address has no proven wallet link');
      return person.id as PersonId;
    } catch (err) {
      this.logger.error(
        `cannot establish a person for ${address}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw new ServiceUnavailableException('cannot establish identity for this address');
    }
  }

  async getReputation(personId: PersonId): Promise<UserReputation> {
    const addresses = await this.people.walletsOf(personId);
    const [completedTrades, profiles] = await Promise.all([
      this.prisma.order.count({ where: { personId, status: 'RELEASED' } }),
      this.prisma.userProfile.aggregate({
        where: { address: { in: addresses } },
        _sum: { disputesLost: true },
      }),
    ]);
    const disputesLost = profiles._sum.disputesLost ?? 0;
    const concluded = completedTrades + disputesLost;
    return {
      tier: this.computeTier(completedTrades, disputesLost),
      completedTrades,
      disputesLost,
      completionRate: concluded > 0 ? completedTrades / concluded : null,
    };
  }

  dailyLimitBaseUnits(tier: UserTierName, config?: { dailyLimitByTier?: unknown } | null): bigint {
    let usdc: number | undefined;
    const raw = config?.dailyLimitByTier;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const val = (raw as Record<string, unknown>)[tier];
      if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
        usdc = val;
      }
    }
    if (usdc === undefined) usdc = DEFAULT_DAILY_LIMIT_USDC[tier];
    return BigInt(Math.round(usdc)) * USDC_BASE_UNITS;
  }

  async used24hBaseUnits(
    personId: PersonId,
    client: OrderQueryable = this.prisma,
    excludeOrderId?: string,
  ): Promise<bigint> {
    const since = new Date(Date.now() - DAY_MS);
    const result = await client.order.aggregate({
      where: {
        personId,
        createdAt: { gte: since },
        status: { notIn: [...VOLUME_EXCLUDED_STATUSES] as any },

        ...(excludeOrderId ? { id: { not: excludeOrderId } } : {}),
      },
      _sum: { usdcAmount: true },
    });
    return (result._sum.usdcAmount as bigint | null) ?? 0n;
  }

  async recordDisputeLost(address: string, orderId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const flipped = await tx.order.updateMany({
        where: { id: orderId, disputeLossAccrued: false },
        data: { disputeLossAccrued: true },
      });
      if (flipped.count === 0) return;
      await tx.userProfile.upsert({
        where: { address },
        update: { disputesLost: { increment: 1 } },
        create: { address, disputesLost: 1 },
      });
    });
  }

  async backfillDisputesLost(): Promise<void> {
    const lostOrders = await this.prisma.order.findMany({
      where: {
        resolution: { not: null },
        status: { in: ['RELEASED', 'REFUNDED'] },
        OR: USER_LOST_WHERE,
      },
      select: { id: true, userAddress: true },
    });

    const counts = new Map<string, number>();
    for (const o of lostOrders) {
      counts.set(o.userAddress, (counts.get(o.userAddress) ?? 0) + 1);
    }
    if (counts.size === 0) return;

    for (const [address, disputesLost] of counts) {
      await this.prisma.userProfile.upsert({
        where: { address },
        update: { disputesLost },
        create: { address, disputesLost },
      });
    }

    const lostOrderIds = lostOrders.map((o) => o.id);
    if (lostOrderIds.length > 0) {
      await this.prisma.order.updateMany({
        where: { id: { in: lostOrderIds } },
        data: { disputeLossAccrued: true },
      });
    }
    this.logger.log(`reputation backfill: set disputesLost for ${counts.size} user(s)`);
  }
}
