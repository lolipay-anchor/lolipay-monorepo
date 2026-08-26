export interface TradeOnChain {
  status: 'FUNDED' | 'FIAT_PAID' | 'RELEASED' | 'REFUNDED' | 'DISPUTED';

  settledAt: number;

  usdcAmount?: bigint;
  fiatAmount?: bigint;
  fiatCurrency?: string;
  flow?: number;
  usdcProvider?: string;
  usdcRecipient?: string;
  confirmer?: string;
  platformWallet?: string;
  lpWallet?: string;
  platformFeeBps?: number;
  lpFeeBps?: number;
  payDeadline?: bigint;
  confirmDeadline?: bigint;
  disputeDeadline?: bigint;
  postSettleDeadline?: bigint;
  slashDeadline?: bigint;
  liabilityEstablished?: boolean;
}
