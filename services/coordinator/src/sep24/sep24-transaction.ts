import type { OrderStatus } from '../generated/prisma/client';
import { applyBps, baseUnitsToUsdcString } from '../money/money';
import { sep24Status, Sep24Status } from './sep24-status';

export interface Sep24Order {
  status: OrderStatus;
  usdcAmount: bigint;
  fiatAmount: bigint;
  fiatCurrency: string;
  platformFeeBps: number;
  lpFeeBps: number;
  releaseTxHash: string | null;
  releasedAt: Date | null;
}

export interface Sep24Record {
  id: string;
  stellarAccount: string;
  startedAt: Date;
  kycVerified: boolean;
  order: Sep24Order | null;
}

export interface Sep24TransactionJson {
  id: string;
  kind: 'deposit';
  status: Sep24Status;
  more_info_url: string;
  started_at: string;
  to: string;
  kyc_verified: boolean;
  amount_in?: string;
  amount_in_asset?: string;
  amount_out?: string;
  amount_out_asset?: string;
  fee_details?: { total: string; asset: string };
  stellar_transaction_id?: string;
  completed_at?: string;
}

export interface Sep24Assets {
  baseUrl: string;
  usdcIssuer: string;
}

export function serializeSep24(record: Sep24Record, assets: Sep24Assets): Sep24TransactionJson {
  const status = sep24Status(record.order);
  const json: Sep24TransactionJson = {
    id: record.id,
    kind: 'deposit',
    status,
    more_info_url: `${assets.baseUrl}/sep24/more-info/${record.id}`,
    started_at: record.startedAt.toISOString(),
    to: record.stellarAccount,
    kyc_verified: record.kycVerified,
  };

  const order = record.order;
  if (!order) return json;

  const fiat = `iso4217:${order.fiatCurrency}`;
  json.amount_in = order.fiatAmount.toString();
  json.amount_in_asset = fiat;
  json.amount_out = baseUnitsToUsdcString(order.usdcAmount);
  json.amount_out_asset = `stellar:USDC:${assets.usdcIssuer}`;
  json.fee_details = {
    total: (
      applyBps(order.fiatAmount, order.platformFeeBps) + applyBps(order.fiatAmount, order.lpFeeBps)
    ).toString(),
    asset: fiat,
  };

  if (status === 'completed') {
    if (order.releaseTxHash) json.stellar_transaction_id = order.releaseTxHash;
    if (order.releasedAt) json.completed_at = order.releasedAt.toISOString();
  }
  return json;
}
