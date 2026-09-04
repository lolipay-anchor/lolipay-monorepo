import type { Flow, OrderStatus } from '../generated/prisma/client';
import { accountOf } from '../sep10/account-signers.service';
import { baseUnitsToUsdcString, splitFees } from '../money/money';
import { sep24Status, Sep24Status } from './sep24-status';
import { MIN_PAY_WINDOW_SECS } from '../config/contract-limits';

export interface Sep24Order {
  status: OrderStatus;
  usdcAmount: bigint;
  fiatAmount: bigint;
  fiatCurrency: string;
  platformFeeBps: number;
  lpFeeBps: number;
  settlementTxHash: string | null;
  settledAt: Date | null;
  ref: string | null;
  payDeadline: bigint;
  confirmDeadline: bigint;
}

export interface Sep24Record {
  id: string;
  stellarAccount: string;
  startedAt: Date;
  kycVerified: boolean;
  flow: Flow;
  order: Sep24Order | null;
}

export interface Sep24TransactionJson {
  id: string;
  kind: 'deposit' | 'withdrawal';
  status: Sep24Status;
  more_info_url: string;
  started_at: string;
  to: string | null;
  from?: string;
  withdraw_anchor_account?: string | null;
  withdraw_memo?: string | null;
  withdraw_memo_type?: string | null;
  kyc_verified: boolean;
  amount_in?: string;
  amount_in_asset?: string;
  amount_out?: string;
  amount_out_asset?: string;
  fee_details?: { total: string; asset: string };
  stellar_transaction_id?: string | null;
  external_transaction_id?: string;
  completed_at?: string | null;
  user_action_required_by?: string;
  message?: string;
}

export interface Sep24Assets {
  baseUrl: string;
  usdcIssuer: string;
}

export function serializeSep24(record: Sep24Record, assets: Sep24Assets): Sep24TransactionJson {
  const withdrawing = record.flow === 'WITHDRAW';
  const status = sep24Status(record.order, record.flow);
  const json: Sep24TransactionJson = {
    id: record.id,
    kind: withdrawing ? 'withdrawal' : 'deposit',
    status,
    more_info_url: `${assets.baseUrl}/sep24/more-info/${record.id}`,
    started_at: record.startedAt.toISOString(),
    to: withdrawing ? null : accountOf(record.stellarAccount),
    kyc_verified: record.kycVerified,
  };
  if (withdrawing) {
    json.from = accountOf(record.stellarAccount);
    json.withdraw_anchor_account = null;
    json.withdraw_memo = null;
    json.withdraw_memo_type = null;
  }

  const order = record.order;
  if (!order) return json;

  const usdc = `stellar:USDC:${assets.usdcIssuer}`;
  const { platformFee, lpFee, net } = splitFees(
    order.usdcAmount,
    order.platformFeeBps,
    order.lpFeeBps,
  );
  const fiat = order.fiatAmount.toString();
  const fiatAsset = `iso4217:${order.fiatCurrency}`;
  const netUsdc = baseUnitsToUsdcString(net);
  const grossUsdc = baseUnitsToUsdcString(order.usdcAmount);
  json.amount_in = withdrawing ? grossUsdc : fiat;
  json.amount_in_asset = withdrawing ? usdc : fiatAsset;
  json.amount_out = withdrawing ? fiat : netUsdc;
  json.amount_out_asset = withdrawing ? fiatAsset : usdc;
  json.fee_details = { total: baseUnitsToUsdcString(withdrawing ? 0n : platformFee + lpFee), asset: usdc };

  const awaited = userAction(withdrawing, order);
  if (awaited) {
    if (awaited.by !== undefined) json.user_action_required_by = new Date(Number(awaited.by) * 1000).toISOString();
    json.message = awaited.message;
  }
  if (order.ref) json.external_transaction_id = order.ref;
  if (status === 'completed' || status === 'refunded') {
    json.stellar_transaction_id = order.settlementTxHash ?? null;
    json.completed_at = order.settledAt?.toISOString() ?? null;
  }
  return json;
}

function userAction(withdrawing: boolean, order: Sep24Order): { by?: bigint; message: string } | null {
  if (withdrawing) {
    if (order.status === 'MATCHED' || order.status === 'AWAITING_ONCHAIN') {
      return {
        by: order.payDeadline - BigInt(MIN_PAY_WINDOW_SECS),
        message: 'Open the withdrawal page and sign in your wallet to lock your USDC in escrow.',
      };
    }
    if (order.status === 'FIAT_PAID') {
      return {
        message:
          'The provider says the rupiah was sent. Check your bank account, then open the withdrawal page to confirm and release the USDC.',
      };
    }
    return null;
  }
  if (order.status === 'FUNDED') {
    return { by: order.payDeadline, message: 'Send the rupiah to the provider account shown on the deposit page.' };
  }
  return null;
}
