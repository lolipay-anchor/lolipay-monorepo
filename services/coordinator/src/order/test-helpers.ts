import { OrderProofService } from './order-proof.service';
import { OrderStatusService } from './order-status.service';
import { OrderTxService } from './order-tx.service';
import { UserReputationService } from '../reputation/user-reputation.service';

export const DANGEROUS_CONTROL_OR_FORMAT_CODE_POINTS: Array<[string, string]> = [
  ['U+200B ZERO WIDTH SPACE', '\u200B'],
  ['U+200E LEFT-TO-RIGHT MARK', '\u200E'],
  ['U+202E RIGHT-TO-LEFT OVERRIDE', '\u202E'],
  ['U+00AD SOFT HYPHEN', '\u00AD'],
  ['U+0000 NULL', '\u0000'],
  ['U+0007 BELL', '\u0007'],
  ['U+001B ESCAPE', '\u001B'],
];

export const WIDENED_BAD_CODE_POINTS: Array<[string, string]> = [
  ['U+2028 LINE SEPARATOR', String.fromCodePoint(0x2028)],
  ['U+2029 PARAGRAPH SEPARATOR', String.fromCodePoint(0x2029)],
  ['U+D800 LONE SURROGATE', String.fromCharCode(0xd800)],
];

export function makeUserReputationStub(
  overrides: Partial<{
    getReputation: jest.Mock;
    dailyLimitBaseUnits: jest.Mock;
    used24hBaseUnits: jest.Mock;
    personIdFor: jest.Mock;
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
    personIdFor: jest.fn().mockResolvedValue('person-test'),
    ...overrides,
  } as unknown as UserReputationService;
}

export function verifiedCustomerStub(
  customerRef?: string,
  personId: string | ((ref: string) => string | undefined) = 'person-test',
) {
  const owner = (ref: string) => (typeof personId === 'function' ? personId(ref) : personId);
  return {
    findUnique: jest.fn(async ({ where }: any) =>
      customerRef === undefined || where.customerRef === customerRef
        ? {
            customerRef: where.customerRef,
            personId: owner(where.customerRef),
            status: 'ACCEPTED',
            screenedAt: new Date(),
          }
        : null,
    ),
    findFirst: jest.fn(async ({ where }: any) =>
      where.status === 'REJECTED' ? null : { personId: where.personId },
    ),
  };
}

export function withTxSupport<T extends Record<string, any>>(prisma: T): T {
  (prisma as Record<string, any>).$transaction = jest.fn((cb: (tx: T) => unknown) => cb(prisma));
  (prisma as Record<string, any>).$executeRaw = jest.fn().mockResolvedValue(0);
  (prisma as Record<string, any>).$queryRaw = jest.fn().mockResolvedValue([{ total: '0' }]);
  return prisma;
}

export function onChainTradeFor(order: any, status: string, overrides: Record<string, any> = {}) {
  const isTopUp = order.flow === 'TOP_UP';
  return {
    status,
    settledAt: 0,
    usdcAmount: BigInt(order.usdcAmount),
    fiatAmount: BigInt(order.fiatAmount),
    fiatCurrency: order.fiatCurrency,
    flow: isTopUp ? 0 : 1,
    usdcProvider: isTopUp ? order.lpWallet : order.userAddress,
    usdcRecipient: isTopUp ? order.userAddress : order.lpWallet,
    confirmer: isTopUp ? order.lpWallet : order.userAddress,
    platformWallet: order.platformWallet,
    lpWallet: order.lpWallet,
    platformFeeBps: order.platformFeeBps,
    lpFeeBps: order.lpFeeBps,
    payDeadline: BigInt(order.payDeadline),
    confirmDeadline: BigInt(order.confirmDeadline),
    disputeDeadline: BigInt(order.disputeDeadline),
    ...overrides,
  };
}

export function orderStatusFor(prisma: any, stellar: any, cfg: any, realtime?: any, notifications?: any) {
  return new OrderStatusService(prisma, stellar, cfg, realtime, notifications);
}

export function orderTxFor(prisma: any, stellar: any, cfg: any, realtime?: any) {
  return new OrderTxService(prisma, stellar, cfg, orderStatusFor(prisma, stellar, cfg, realtime));
}

export function orderProofFor(prisma: any, stellar: any, cfg: any, storage: any) {
  return new OrderProofService(prisma, cfg, storage, orderStatusFor(prisma, stellar, cfg));
}
