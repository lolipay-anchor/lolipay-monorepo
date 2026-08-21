export interface TradeOnChain {
  status: 'FUNDED' | 'FIAT_PAID' | 'RELEASED' | 'REFUNDED' | 'DISPUTED';

  settledAt: number;
}
