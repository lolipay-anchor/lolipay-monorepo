export type OrderStatus =
  | 'CREATED' | 'MATCHED' | 'AWAITING_ONCHAIN' | 'FUNDED' | 'FIAT_PAID'
  | 'RELEASED' | 'REFUNDED' | 'DISPUTED' | 'EXPIRED' | 'CANCELLED'

export type Flow = 'TOP_UP' | 'WITHDRAW'
export type Rail = 'BANK' | 'QRIS' | 'EWALLET'

export type TopUpDisputeReason = 'USDC_NOT_RELEASED' | 'PAID_WRONG_AMOUNT' | 'OTHER'
export type FiatPayerDisputeReason = 'PAYMENT_NOT_RECEIVED' | 'WRONG_AMOUNT' | 'FAKE_PROOF' | 'OTHER'
export type DisputeReason = TopUpDisputeReason | FiatPayerDisputeReason

export interface Quote {
  quote_id: string
  usdc_amount: string
  fiat_amount: string
  rate: string
  platform_fee_bps: number
  lp_fee_bps: number
  expires_at: string
}

export interface Order {
  id: string
  trade_id: string

  user_address: string | null
  lp_wallet: string | null
  flow: Flow
  rail: Rail
  usdc_amount: string
  fiat_amount: string
  fiat_currency: string
  rate_snapshot: string
  platform_fee_bps: number
  lp_fee_bps: number
  status: OrderStatus
  pay_deadline: number
  confirm_deadline: number
  dispute_deadline: number
  expires_at: string
  sign_by?: number
  created_at: string
  payment_instructions?: string
  lp_reputation?: LpReputation

  ref?: string | null

  proof_url?: string | null

  proof_rrn?: string | null

  proof_amount?: string | null

  proof_paid_at?: string | null

  settled_at?: string | null
  dispute_by?: 'user' | 'lp' | null
  on_chain_disputed_by?: string | null
  resolver_disputed?: boolean
  dispute_reason?: DisputeReason | null
  dispute_note?: string | null
  dispute_evidence_url?: string | null
  dispute_at?: string | null
  resolution?: string | null

  post_settle_dispute_until?: string | null
}

export interface LpReputation {
  completed_trades: number
  completion_rate: number | null
  member_since: string
  online: boolean
}

export type UserTier = 'BRONZE' | 'SILVER' | 'TRUSTED' | 'GOLD'

export interface UserProfile {
  tier: UserTier
  completed_trades: number
  disputes_lost: number
  completion_rate: number | null
  daily_limit_usdc: number
  daily_used_usdc: number
  daily_remaining_usdc: number
}

export interface CreateTradeParams {
  trade_id: string
  usdc_provider: string
  usdc_recipient: string
  confirmer: string
  usdc_amount: string
  pay_deadline: number
  confirm_deadline: number
  dispute_deadline: number
  platform_wallet: string
  platform_fee_bps: number
  lp_fee_bps: number
}

export interface CreateOrderResponse {
  order: Order
  create_trade_params?: CreateTradeParams
}

export interface PostDisputeResponse {
  order: Order
  dispute_tx: TxEnvelope
}

export interface TxEnvelope { xdr: string; networkPassphrase: string }

export interface Rate { asset: string; fiat: string; rate: string; ts: string }

export interface Market {
  code: string
  country: string
  currency_symbol: string
  locale: string
  rail_name: string
  enabled: boolean
}

export type LpStatus = 'PENDING' | 'APPROVED' | 'SUSPENDED' | 'REVOKED'

export interface Lp {
  id: string
  stellarAddress: string
  status: LpStatus
  contact: string
  liquidityProof: string
  approvalNote: string | null
  online: boolean

  lastHeartbeatAt: string | null
  createdAt: string
  approvedAt: string | null
}

export interface PaymentMethod {
  id: string
  lpId: string
  rail: Rail
  label: string
  details: string
  currency: string
  active: boolean
}

export type LpMe = Lp & { paymentMethods: PaymentMethod[] }

export interface AdminConfig {
  id: number
  spreadBps: number
  platformFeeBps: number
  lpFeeBps: number
  platformWallet: string
  minOrder: string
  maxOrder: string
  payWindowSecs: number
  confirmWindowSecs: number
  disputeWindowSecs: number
  paused: boolean
  updatedAt: string

  requireProof: boolean
  autoRefund: boolean

  postSettleDisputeWindowSecs: number
}

export interface OrderRisk {
  wallet_age_days: number | null
  user_dispute_velocity_30d: number
  lp_dispute_velocity_30d: number
  amount_vs_tier_limit: {
    order_usdc: number
    tier: UserTier
    daily_limit_usdc: number
    ratio: number | null
  }
  lp_completion: {
    completed_trades: number
    completion_rate: number | null
    member_since: string
    online: boolean
  } | null
}

export interface Assignment {
  order: Order
  create_trade_params?: CreateTradeParams

  require_proof?: boolean
}

export interface Eligibility {
  staked: string
  unbonding: string
  unbond_available_at: number
  min_stake: string
  eligible: boolean
}

export interface Notification {
  id: string
  address: string
  orderId: string | null
  event: string
  title: string
  body: string
  read: boolean
  createdAt: string
}

export interface NotificationsResponse {
  items: Notification[]
  unread: number
}

export type MetricsRange = '24h' | '7d' | '30d'

export interface MetricsOverview {
  range: MetricsRange
  volume_usdc: number
  fees_usdc: number
  avg_settle_secs: number | null
  open_disputes: number
  orders_count: number
  daily_bars: { date: string; volume_usdc: number }[]
  flow_mix: { flow: string; count: number; volume_usdc: number }[]
  top_lps: { lp_id: string; address: string | null; volume_usdc: number; trades: number }[]
}

export interface LpEarningsDayBar {
  date: string
  volume_usdc: number
  earned_usdc: number
}

export interface LpEarnings {
  today_trades: number
  today_earned_usdc: number
  today_volume_usdc: number
  week_bars: LpEarningsDayBar[]
  all_time_trades: number
  all_time_earned_usdc: number
}
