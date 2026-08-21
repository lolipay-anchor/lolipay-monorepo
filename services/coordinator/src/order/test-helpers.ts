import { UserReputationService } from '../reputation/user-reputation.service';
export function makeUserReputationStub(
  overrides: Partial<{
    getReputation: jest.Mock;
    dailyLimitBaseUnits: jest.Mock;
    used24hBaseUnits: jest.Mock;
  }> = {},
): UserReputationService {
  return {
    getReputation: jest.fn().mockResolvedValue({
      tier: 'GOLD',
      completedTrades: 999,
      disputesLost: 0,
      completionRate: 1,
    }),
    dailyLimitBaseUnits: jest.fn().mockReturnValue(9_999_999_999_999n),
    used24hBaseUnits: jest.fn().mockResolvedValue(0n),
    ...overrides,
  } as unknown as UserReputationService;
}

export function withTxSupport<T extends Record<string, any>>(prisma: T): T {
  (prisma as Record<string, any>).$transaction = jest.fn((cb: (tx: T) => unknown) => cb(prisma));
  (prisma as Record<string, any>).$executeRaw = jest.fn().mockResolvedValue(0);
  return prisma;
}
