import { ForbiddenException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { NO_PROVIDER_SENTENCE, withInteractiveSentence } from '../sep24/interactive-sentence';
import { PrismaService } from '../prisma/prisma.service';
import { PersonId, PersonService } from '../person/person.service';
import { StellarReadService } from '../stellar/stellar-read.service';
import { lpExposure } from '../order/lp-exposure';

export interface LpMatch {
  id: string;
  stellarAddress: string;
  paymentMethodId: string;
  details: string;
  label: string;
  staked: bigint;
}

export function heartbeatStaleMs() {
  return Number(process.env.HEARTBEAT_STALE_SECONDS ?? 120) * 1000;
}

export function matchableLpWhere() {
  return {
    status: 'APPROVED' as const,
    online: true,
    paymentMethods: { some: { active: true } },
  };
}

@Injectable()
export class MatchingService {
  private readonly log = new Logger('MatchingService');

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

    let stakeUnreadable = 0;
    let ineligible = 0;
    let overCapacity = 0;

    for (const lp of others) {
      let stake: { staked: string; unbonding: string; eligible: boolean };
      try {
        stake = await this.stellar.getStakeInfo(lp.stellarAddress);
      } catch {
        stakeUnreadable++;
        continue;
      }
      if (!stake.eligible) {
        ineligible++;
        continue;
      }

      const staked = BigInt(stake.staked);
      const committed = await lpExposure(this.prisma, lp.id, nowSec);
      if (committed + amount > staked) {
        overCapacity++;
        continue;
      }

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
        label: pm.label,
        staked,
      };
    }

    if (refusedOwn && others.length === 0) {
      throw new ForbiddenException('you cannot be matched with your own order');
    }
    this.log.warn(
      `no provider took ${rail}/${fiat} for ${amount} base units — ${candidates.length} matchable, ` +
        `${candidates.length - others.length} excluded as the requester's own, ${stakeUnreadable} stake unreadable, ` +
        `${ineligible} under the minimum stake, ${overCapacity} over capacity`,
    );
    throw withInteractiveSentence(
      new ServiceUnavailableException('no eligible LP available'),
      NO_PROVIDER_SENTENCE,
    );
  }
}
