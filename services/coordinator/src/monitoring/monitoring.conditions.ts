import { Prisma } from '../generated/prisma/client';
import type { AuditAction } from '../admin/admin-audit';

export const ALERT_SAMPLE_LIMIT = 500;
export const ALERT_TEXT_BUDGET = 1800;
export const DISPUTE_STALE_DAYS = 30;
export const SLASH_SCAN_LIMIT = 100;
export const ATTESTATION_AUDIT_ACTION: AuditAction = 'order.attestFiatPaid';
export const ATTESTATION_FAILURE_WINDOW_MS = 60 * 60 * 1000;
export const STROOPS_PER_XLM = 10_000_000n;
export const ATTESTOR_LOW_BALANCE_XLM = 25n;
export const ATTESTOR_LOW_BALANCE_STROOPS = ATTESTOR_LOW_BALANCE_XLM * STROOPS_PER_XLM;

const PLAIN_TOKEN = /^[A-Za-z0-9_-]{1,80}$/;
const OUTCOME_LABEL = /^[A-Z_]{1,32}$/;

function fieldOf(json: unknown, key: string): unknown {
  return typeof json === 'object' && json !== null ? (json as Record<string, unknown>)[key] : undefined;
}

function safe(value: unknown, pattern: RegExp, fallback: string): string {
  return typeof value === 'string' && pattern.test(value) ? value : fallback;
}

export function attestationDidNotSucceed(after: unknown): boolean {
  return fieldOf(after, 'submission') !== 'SUCCESS';
}

export function describeAttestationAttempt(row: { targetId: string | null; before: unknown; after: unknown }) {
  return {
    orderId: safe(row.targetId, PLAIN_TOKEN, 'unknown'),
    tradeId: safe(fieldOf(row.before, 'tradeId'), PLAIN_TOKEN, 'unknown'),
    outcome: safe(fieldOf(row.after, 'submission'), OUTCOME_LABEL, 'unrecognised'),
  };
}

const WINDOW_UNITS = [
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
  ['second', 1000],
] as const;

export function windowWords(ms: number): string {
  for (const [unit, size] of WINDOW_UNITS) {
    if (ms % size === 0) return ms === size ? unit : `${ms / size} ${unit}s`;
  }
  return `${ms} milliseconds`;
}

export function formatXlm(stroops: bigint): string {
  return `${stroops / STROOPS_PER_XLM}.${(stroops % STROOPS_PER_XLM).toString().padStart(7, '0')}`;
}

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
      return `first noticed ${humanDuration(now - history.firstSeenAt.getTime())} ago, sent ${history.sendCount} time${history.sendCount === 1 ? '' : 's'} before this one`;
  }
}
