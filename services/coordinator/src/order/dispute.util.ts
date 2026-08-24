export function canDispute(
  order: { status: string; settledAt: Date | null },
  config: { postSettleDisputeWindowSecs: number },
): boolean {
  if (order.status === 'FIAT_PAID') return true;
  if (order.status === 'RELEASED' || order.status === 'REFUNDED') {
    if (!order.settledAt) return false;
    const deadlineMs = order.settledAt.getTime() + config.postSettleDisputeWindowSecs * 1000;
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

export function isOwnEvidencePath(evidenceUrl: string, orderId: string, role: 'user' | 'lp'): boolean {
  const prefix = `evidence/${orderId}-${role}.`;
  if (!evidenceUrl.startsWith(prefix)) return false;
  const ext = evidenceUrl.slice(prefix.length);
  return EVIDENCE_EXTENSIONS.includes(ext);
}

export function postSettleDisputeDeadline(
  order: { status: string; settledAt: Date | null; disputeBy: string | null },
  config: { postSettleDisputeWindowSecs: number },
): string | null {
  if (order.status !== 'RELEASED' && order.status !== 'REFUNDED') return null;
  if (!order.settledAt) return null;
  if (order.disputeBy) return null;
  const deadlineMs = order.settledAt.getTime() + config.postSettleDisputeWindowSecs * 1000;
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

