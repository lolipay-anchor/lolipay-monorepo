import { TradeOnChain } from '../stellar/stellar-read.types';
import { Flow, mapRoles } from './order.params';

export const BOUND_ON_CHAIN = ['FUNDED', 'FIAT_PAID', 'DISPUTED', 'RELEASED', 'REFUNDED'];

export function notYetBoundOnChain(status: string): boolean {
  return !BOUND_ON_CHAIN.includes(status);
}

export interface OrderBindingFields {
  flow: string;
  userAddress: string;
  lpWallet: string | null;
  usdcAmount: bigint;
  fiatAmount: bigint;
  fiatCurrency: string;
  platformFeeBps: number;
  lpFeeBps: number;
  platformWallet: string;
  payDeadline: bigint;
  confirmDeadline: bigint;
  disputeDeadline: bigint;
}

const FLOW_DISCRIMINANT: Record<string, number> = {
  TOP_UP: 0,
  WITHDRAW: 1,
};

function bigintOrNull(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  return null;
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'bigint' && v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Number(v);
  }
  return null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function compareBigint(field: string, actual: unknown, expected: bigint, out: string[]): void {
  const got = bigintOrNull(actual);
  if (got === null) {
    out.push(`${field}: missing or undecodable on chain (expected ${expected})`);
    return;
  }
  if (got !== expected) out.push(`${field}: chain=${got} order=${expected}`);
}

function compareNumber(field: string, actual: unknown, expected: number, out: string[]): void {
  const got = numberOrNull(actual);
  if (got === null) {
    out.push(`${field}: missing or undecodable on chain (expected ${expected})`);
    return;
  }
  if (got !== expected) out.push(`${field}: chain=${got} order=${expected}`);
}

function compareString(field: string, actual: unknown, expected: string, out: string[]): void {
  const got = stringOrNull(actual);
  if (got === null) {
    out.push(`${field}: missing or undecodable on chain (expected ${expected})`);
    return;
  }
  if (got !== expected) out.push(`${field}: chain=${got} order=${expected}`);
}

export function verifyTradeMatchesOrder(
  trade: TradeOnChain,
  order: OrderBindingFields,
): string[] {
  const mismatches: string[] = [];

  if (!order.lpWallet) {
    return ['lpWallet: order has no matched provider, cannot bind an on-chain trade to it'];
  }

  const expectedFlow = FLOW_DISCRIMINANT[order.flow];
  if (expectedFlow === undefined) {
    return [`flow: order carries an unknown flow (${order.flow})`];
  }

  const roles = mapRoles(order.flow as Flow, order.userAddress, order.lpWallet);

  compareBigint('usdcAmount', trade.usdcAmount, order.usdcAmount, mismatches);
  compareBigint('fiatAmount', trade.fiatAmount, order.fiatAmount, mismatches);
  compareString('fiatCurrency', trade.fiatCurrency, order.fiatCurrency, mismatches);
  compareNumber('flow', trade.flow, expectedFlow, mismatches);

  compareString('usdcProvider', trade.usdcProvider, roles.usdcProvider, mismatches);
  compareString('usdcRecipient', trade.usdcRecipient, roles.usdcRecipient, mismatches);
  compareString('confirmer', trade.confirmer, roles.confirmer, mismatches);

  compareString('platformWallet', trade.platformWallet, order.platformWallet, mismatches);
  compareString('lpWallet', trade.lpWallet, order.lpWallet, mismatches);

  compareNumber('platformFeeBps', trade.platformFeeBps, order.platformFeeBps, mismatches);
  compareNumber('lpFeeBps', trade.lpFeeBps, order.lpFeeBps, mismatches);

  compareBigint('payDeadline', trade.payDeadline, order.payDeadline, mismatches);
  compareBigint('confirmDeadline', trade.confirmDeadline, order.confirmDeadline, mismatches);
  compareBigint('disputeDeadline', trade.disputeDeadline, order.disputeDeadline, mismatches);

  return mismatches;
}
