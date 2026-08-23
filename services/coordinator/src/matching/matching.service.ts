import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PersonId, PersonService } from '../person/person.service';
import { StellarReadService } from '../stellar/stellar-read.service';

export interface LpMatch {
  id: string;
  stellarAddress: string;
  paymentMethodId: string;
  details: string;
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
    excludePersonId?: PersonId,
  ): Promise<LpMatch> {
    const staleMs = Number(process.env.HEARTBEAT_STALE_SECONDS ?? 120) * 1000;

    const candidates = await this.prisma.lp.findMany({
      where: {
        status: 'APPROVED',
        online: true,
        lastHeartbeatAt: { gt: new Date(Date.now() - staleMs) },
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

    for (const lp of others) {
      let eligible = false;
      try {
        eligible = await this.stellar.isEligible(lp.stellarAddress);
      } catch {
        continue;
      }
      if (eligible) {
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
        };
      }
    }

    if (refusedOwn && others.length === 0) {
      throw new ForbiddenException('you cannot be matched with your own order');
    }
    throw new ServiceUnavailableException('no eligible LP available');
  }
}
