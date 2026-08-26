import { Prisma } from '../generated/prisma/client';

export const ALERT_SAMPLE_LIMIT = 500;
export const ALERT_TEXT_LIMIT = 50;
export const ALERT_TEXT_BUDGET = 1800;
export const DISPUTE_STALE_DAYS = 30;
export const SLASH_SCAN_LIMIT = 100;

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

export function slashCandidatesWhere(): import('../generated/prisma/client').Prisma.OrderWhereInput {
  return {
    status: { in: ['RELEASED', 'REFUNDED', 'DISPUTED'] },
    settledAt: { not: null },
    OR: [
      { flow: 'TOP_UP', status: 'REFUNDED' },
      { flow: 'WITHDRAW', status: 'RELEASED' },
      { status: 'DISPUTED' },
    ],
  };
}
