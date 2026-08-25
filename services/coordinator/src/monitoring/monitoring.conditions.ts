import { Prisma } from '../generated/prisma/client';

export const ALERT_SAMPLE_LIMIT = 50;

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
