import type { OrderStatus } from '../generated/prisma/client';

export type Sep24Status =
  | 'incomplete'
  | 'pending_anchor'
  | 'pending_user_transfer_start'
  | 'completed'
  | 'refunded'
  | 'expired';

export const SEP24_EMITTED_STATUSES: readonly Sep24Status[] = [
  'incomplete',
  'pending_anchor',
  'pending_user_transfer_start',
  'completed',
  'refunded',
  'expired',
];

const BY_ORDER_STATUS: Record<OrderStatus, Sep24Status> = {
  CREATED: 'pending_anchor',
  MATCHED: 'pending_anchor',
  AWAITING_ONCHAIN: 'pending_anchor',
  FUNDED: 'pending_user_transfer_start',
  FIAT_PAID: 'pending_anchor',
  RELEASED: 'completed',
  REFUNDED: 'refunded',
  DISPUTED: 'pending_anchor',
  EXPIRED: 'expired',
  CANCELLED: 'expired',
};

export function sep24Status(order: { status: OrderStatus } | null): Sep24Status {
  if (!order) return 'incomplete';
  const mapped = BY_ORDER_STATUS[order.status];
  if (!mapped) {
    throw new Error(`sep24Status: no SEP-24 status is mapped for order status ${order.status}`);
  }
  return mapped;
}
