import type { Flow, OrderStatus } from '../generated/prisma/client';
import { baseUnitsToUsdcString, splitFees } from '../money/money';
import { sep24Status, Sep24Status } from './sep24-status';

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
    to: withdrawing ? null : record.stellarAccount,
    kyc_verified: record.kycVerified,
  };
  if (withdrawing) {
    json.from = record.stellarAccount;
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
  json.amount_in = withdrawing ? netUsdc : fiat;
  json.amount_in_asset = withdrawing ? usdc : fiatAsset;
  json.amount_out = withdrawing ? fiat : netUsdc;
  json.amount_out_asset = withdrawing ? fiatAsset : usdc;
  json.fee_details = { total: baseUnitsToUsdcString(platformFee + lpFee), asset: usdc };

  if (order.ref) json.external_transaction_id = order.ref;
  if (status === 'completed' || status === 'refunded') {
    json.stellar_transaction_id = order.settlementTxHash ?? null;
    json.completed_at = order.settledAt?.toISOString() ?? null;
  }
  return json;
}
