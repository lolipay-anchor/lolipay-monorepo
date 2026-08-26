import { OrderService } from './order.service';
import { makeUserReputationStub, orderStatusFor, orderTxFor } from './test-helpers';
import { PROVIDER_LOST_WHERE, providerLostDispute } from '../reputation/dispute-outcome';

describe('getLpReputation does not reward a provider for losing a dispute (S7/S8)', () => {
  function make(counts: { completed: number; refunded: number }, lpOverrides: any = {}) {
    const calls: any[] = [];
    const prisma = {
      order: {
        count: jest.fn().mockImplementation(async (args: any) => {
          calls.push(args);
          return calls.length === 1 ? counts.completed : counts.refunded;
        }),
      },
    } as any;
    const svc = new OrderService(
      prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any,
      makeUserReputationStub(),
      orderStatusFor(prisma, {} as any, {} as any), orderTxFor(prisma, {} as any, {} as any),
    );
    const lp = {
      online: true,
      approvedAt: new Date('2026-01-01T00:00:00Z'),
      createdAt: new Date('2026-01-01T00:00:00Z'),
      disputesLost: 0,
      ...lpOverrides,
    };
    return { svc, prisma, lp, calls };
  }

  it('excludes every trade the rule says the provider lost, not just the one shape', async () => {
    const { svc, lp, calls } = make({ completed: 3, refunded: 0 });
    await svc.getLpReputation(`lp-${Math.random()}`, lp);

    expect(calls[0].where).toMatchObject({
      status: 'RELEASED',
      NOT: { OR: PROVIDER_LOST_WHERE },
    });
    for (const combination of calls[0].where.NOT.OR) {
      expect(providerLostDispute(combination.flow, combination.resolution)).toBe(true);
    }
  });

  it('surfaces the provider dispute-loss counter', async () => {
    const { svc, lp } = make({ completed: 5, refunded: 1 }, { disputesLost: 2 });
    const rep = await svc.getLpReputation(`lp-${Math.random()}`, lp);
    expect(rep.disputes_lost).toBe(2);
  });

  it('reports zero rather than undefined for a provider that has never lost one', async () => {
    const { svc, lp } = make({ completed: 1, refunded: 0 }, { disputesLost: undefined });
    const rep = await svc.getLpReputation(`lp-${Math.random()}`, lp);
    expect(rep.disputes_lost).toBe(0);
  });
});
