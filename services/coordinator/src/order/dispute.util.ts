export function postSettleDeadlineMs(
  order: { settledAt: Date | null; postSettleDeadline?: bigint | null },
  config: { postSettleDisputeWindowSecs: number },
): number | null {
  if (order.postSettleDeadline) return Number(order.postSettleDeadline) * 1000;
  if (!order.settledAt) return null;
  return order.settledAt.getTime() + config.postSettleDisputeWindowSecs * 1000;
}

export function canDispute(
  order: { status: string; settledAt: Date | null; postSettleDeadline?: bigint | null },
  config: { postSettleDisputeWindowSecs: number },
): boolean {
  if (order.status === 'FIAT_PAID') return true;
  if (order.status === 'RELEASED' || order.status === 'REFUNDED') {
    const deadlineMs = postSettleDeadlineMs(order, config);
    if (deadlineMs === null) return false;
    return Date.now() <= deadlineMs;
  }
  return false;
}

export const TOP_UP_DISPUTE_REASONS = ['USDC_NOT_RELEASED', 'PAID_WRONG_AMOUNT', 'OTHER'] as const;
export const FIAT_PAYER_DISPUTE_REASONS = [
  'PAYMENT_NOT_RECEIVED',
  'WRONG_AMOUNT',
  'FAKE_PROOF',
  'OTHER',
] as const;
export const ALL_DISPUTE_REASONS: readonly string[] = Array.from(
  new Set<string>([...TOP_UP_DISPUTE_REASONS, ...FIAT_PAYER_DISPUTE_REASONS]),
);

export function allowedDisputeReasons(flow: string): readonly string[] {
  return flow === 'TOP_UP' ? TOP_UP_DISPUTE_REASONS : FIAT_PAYER_DISPUTE_REASONS;
}

const EVIDENCE_EXTENSIONS = ['jpg', 'png', 'webp', 'pdf'];

export function evidenceKeyFor(orderId: string, role: 'user' | 'lp', closedAt: Date | null): string {
  return closedAt ? `${orderId}-${role}-${closedAt.getTime()}` : `${orderId}-${role}`;
}

export function isOwnEvidencePath(
  evidenceUrl: string,
  orderId: string,
  role: 'user' | 'lp',
  closedAt: Date | null,
): boolean {
  const prefix = `evidence/${evidenceKeyFor(orderId, role, closedAt)}.`;
  if (!evidenceUrl.startsWith(prefix)) return false;
  const ext = evidenceUrl.slice(prefix.length);
  return EVIDENCE_EXTENSIONS.includes(ext);
}

export function postSettleDisputeDeadline(
  order: {
    status: string;
    settledAt: Date | null;
    disputeBy: string | null;
    disputeReason?: string | null;
    postSettleDeadline?: bigint | null;
  },
  config: { postSettleDisputeWindowSecs: number },
): string | null {
  if (order.status !== 'RELEASED' && order.status !== 'REFUNDED') return null;
  if (order.disputeBy) return null;
  const deadlineMs = postSettleDeadlineMs(order, config);
  if (deadlineMs === null) return null;
  if (Date.now() > deadlineMs) return null;
  return new Date(deadlineMs).toISOString();
}

export const ATTEST_GRACE_SECS = 3600n;

export function refundOpensAt(order: {
  flow: string;
  payDeadline: bigint;
  confirmDeadline: bigint;
}): bigint {
  if (order.flow !== 'TOP_UP') return order.confirmDeadline;
  const graced = order.payDeadline + ATTEST_GRACE_SECS;
  return graced < order.confirmDeadline ? graced : order.confirmDeadline;
}

