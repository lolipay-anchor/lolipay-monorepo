import { ConflictException } from '@nestjs/common';
import { randomBytes } from 'crypto';

export type Flow = 'TOP_UP' | 'WITHDRAW';

export interface Roles {
  usdcProvider: string;
  usdcRecipient: string;
  confirmer: string;
}

export function mapRoles(flow: Flow, user: string, lp: string): Roles {
  if (flow === 'TOP_UP') {
    return { usdcProvider: lp, usdcRecipient: user, confirmer: lp };
  }

  return { usdcProvider: user, usdcRecipient: lp, confirmer: user };
}

export function newTradeId(): string {
  return randomBytes(32).toString('hex');
}

export function contractIdFor(
  order: { contractId?: string | null },
  cfg: { escrowContractId: string },
): string {
  return order.contractId ?? cfg.escrowContractId;
}

export function getFiatPayer(flow: Flow, user: string, lpAddress: string): string {
  return flow === 'TOP_UP' ? user : lpAddress;
}

export function requireLp<T extends { stellarAddress: string }>(order: { lp: T | null }): T {
  if (!order.lp) {
    throw new ConflictException('order has no matched LP yet');
  }
  return order.lp;
}
