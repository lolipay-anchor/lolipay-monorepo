import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PersonId, PersonService } from '../person/person.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { lpExposure } from '../order/lp-exposure';

export interface LpMatch {
  id: string;
  stellarAddress: string;
  paymentMethodId: string;
  details: string;
  staked: bigint;
}

export function heartbeatStaleMs() {
  return Number(process.env.HEARTBEAT_STALE_SECONDS ?? 120) * 1000;
}

export function matchableLpWhere(now: Date = new Date()) {
  return {
    status: 'APPROVED' as const,
    online: true,
    lastHeartbeatAt: { gt: new Date(now.getTime() - heartbeatStaleMs()) },
    paymentMethods: { some: { active: true } },
  };
}

@Injectable()
export class MatchingService {
  constructor(
    private prisma: PrismaService,
    private stellar: StellarReadService,
    private people: PersonService,
  ) {}

  async pickLp(
    rail: 'BANK' | 'QRIS' | 'EWALLET',
    fiat: string,
    amount: bigint,
    excludePersonId?: PersonId,
  ): Promise<LpMatch> {
    const candidates = await this.prisma.lp.findMany({
      where: {
        ...matchableLpWhere(),
        paymentMethods: { some: { rail, active: true, currency: fiat } },
      },
      include: {
        paymentMethods: { where: { rail, active: true, currency: fiat } },
        _count: {
          select: {
            orders: {
              where: {
                status: {
                  in: ['MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID'],
                },
              },
            },
          },
        },
      },
    });

    candidates.sort((a, b) => a._count.orders - b._count.orders);

    const own = excludePersonId
      ? new Set(await this.people.walletsOf(excludePersonId))
      : new Set<string>();

    const others = candidates.filter((lp) => !own.has(lp.stellarAddress));
    const refusedOwn = others.length < candidates.length;

    const nowSec = Math.floor(Date.now() / 1000);

    for (const lp of others) {
      let stake: { staked: string; unbonding: string; eligible: boolean };
      try {
        stake = await this.stellar.getStakeInfo(lp.stellarAddress);
      } catch {
        continue;
      }
      if (!stake.eligible || BigInt(stake.unbonding) > 0n) continue;

      const staked = BigInt(stake.staked);
      const committed = await lpExposure(this.prisma, lp.id, nowSec);
      if (committed + amount > staked) continue;

      const owner = await this.people.lookupPerson(lp.stellarAddress);
      if (excludePersonId && owner?.id === excludePersonId) {
        throw new ForbiddenException('you cannot be matched with your own order');
      }
      const pm = lp.paymentMethods[0];
      return {
        id: lp.id,
        stellarAddress: lp.stellarAddress,
        paymentMethodId: pm.id,
        details: pm.details,
        staked,
      };
    }

    if (refusedOwn && others.length === 0) {
      throw new ForbiddenException('you cannot be matched with your own order');
    }
    throw new ServiceUnavailableException('no eligible LP available');
  }
}
