export type AuditAction =
  | 'lp.register'
  | 'lp.setStatus'
  | 'config.update'
  | 'market.update'
  | 'order.attestFiatPaid'
  | 'order.disputeRoundClosed';

export interface AuditEntry {
  actorAddress: string;
  action: AuditAction;
  targetType: 'Lp' | 'Config' | 'Market' | 'Order';
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
}

export function auditPayload(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(auditPayload);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = auditPayload(v);
    }
    return out;
  }
  return value;
}

export interface AuditClient {
  adminAudit: { create: (args: { data: Record<string, unknown> }) => Promise<unknown> };
}

export async function recordAudit(tx: AuditClient, entry: AuditEntry): Promise<void> {
  await tx.adminAudit.create({
    data: {
      actorAddress: entry.actorAddress,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId ?? null,
      before: auditPayload(entry.before) as never,
      after: auditPayload(entry.after) as never,
    },
  });
}
