import { Prisma } from '../generated/prisma/client';

export const ALERT_SAMPLE_LIMIT = 500;
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

export function slashCandidatesWhere(now: Date = new Date()): Prisma.OrderWhereInput {
  return {
    liabilityEstablished: true,
    slashDeadline: { gt: BigInt(Math.floor(now.getTime() / 1000)) },
  };
}

export type AlertHistory =
  | { kind: 'first' }
  | { kind: 'unreadable' }
  | { kind: 'known'; firstSeenAt: Date; sendCount: number };

export function humanDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  if (seconds < 60) return seconds === 0 ? 'moments' : `${seconds} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

export function alertAgeSentence(history: AlertHistory, now: number = Date.now()): string {
  switch (history.kind) {
    case 'first':
      return 'first noticed just now';
    case 'unreadable':
      return 'how long this has been going on and how many times it was sent could not be read';
    case 'known':
      return `first noticed ${humanDuration(now - history.firstSeenAt.getTime())} ago, sent ${history.sendCount} time(s) before this one`;
  }
}
