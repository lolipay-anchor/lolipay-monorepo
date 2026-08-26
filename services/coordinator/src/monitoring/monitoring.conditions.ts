import { Prisma } from '../generated/prisma/client';

export const ALERT_SAMPLE_LIMIT = 500;
export const ALERT_TEXT_LIMIT = 50;
export const ALERT_TEXT_BUDGET = 1800;
export const DISPUTE_STALE_DAYS = 30;
export const SLASH_SCAN_LIMIT = 100;
export const MAX_DISPUTE_WINDOW_SECS = 604_800;
export const RESOLVER_WINDOW_SECS = 86_400;
export const SLASH_REACHABLE_SECS = MAX_DISPUTE_WINDOW_SECS + 2 * RESOLVER_WINDOW_SECS;

export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

export function openDisputesWhere(): Prisma.OrderWhereInput {
  return { status: 'DISPUTED' };
}

export function releaseOverdueWhere(now: bigint): Prisma.OrderWhereInput {
  return { status: 'FIAT_PAID', confirmDeadline: { lt: now } };
}

export function fiatPaymentOverdueWhere(now: bigint): Prisma.OrderWhereInput {
  return {
    status: 'FUNDED',
    OR: [
      { flow: 'TOP_UP', payDeadline: { lt: now } },
      { flow: 'WITHDRAW', confirmDeadline: { lt: now } },
    ],
  };
}

export function slashCandidatesWhere(
  now: Date = new Date(),
): import('../generated/prisma/client').Prisma.OrderWhereInput {
  const reachableSince = new Date(now.getTime() - SLASH_REACHABLE_SECS * 1000);
  return {
    status: { in: ['RELEASED', 'REFUNDED', 'DISPUTED'] },
    settledAt: { not: null, gte: reachableSince },
    OR: [
      { flow: 'TOP_UP', status: 'REFUNDED' },
      { flow: 'WITHDRAW', status: 'RELEASED' },
      { status: 'DISPUTED' },
    ],
  };
}
