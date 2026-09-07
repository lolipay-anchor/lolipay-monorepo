import { serializeOrderBase } from './order.serialize';

const KEYS_BEFORE = [
  'id', 'trade_id', 'user_address', 'lp_wallet', 'flow', 'rail', 'usdc_amount', 'fiat_amount',
  'fiat_currency', 'rate_snapshot', 'platform_fee_bps', 'lp_fee_bps', 'status', 'pay_deadline',
  'confirm_deadline', 'dispute_deadline', 'expires_at', 'sign_by', 'created_at', 'ref', 'proof_url',
  'proof_rrn', 'proof_amount', 'proof_paid_at', 'settled_at', 'dispute_by', 'dispute_reason',
  'dispute_note', 'dispute_evidence_url', 'dispute_at', 'resolution', 'resolver_disputed',
  'on_chain_disputed_by', 'post_settle_dispute_until',
];

const order = {
  id: 'o1',
  tradeId: 'a'.repeat(64),
  userAddress: 'GUSER',
  lpWallet: 'GLP',
  flow: 'TOP_UP',
  rail: 'BANK',
  usdcAmount: 100000000n,
  fiatAmount: 1600000n,
  fiatCurrency: 'IDR',
  rateSnapshot: '16000',
  platformFeeBps: 30,
  lpFeeBps: 120,
  status: 'RELEASED',
  payDeadline: 4_000_000_000n,
  confirmDeadline: 4_000_001_800n,
  disputeDeadline: 4_000_009_000n,
  expiresAt: new Date(3_999_999_400_000),
  createdAt: new Date(),
  settledAt: new Date(),
};

describe('an order carries the hash of the transaction that settled it', () => {
  it('publishes settlement_tx_hash once the indexer has recorded it', () => {
    const json = serializeOrderBase({ ...order, settlementTxHash: 'ab'.repeat(32) });
    expect(json.settlement_tx_hash).toBe('ab'.repeat(32));
  });

  it('publishes null before settlement, and null when the field is absent from the row', () => {
    expect(serializeOrderBase({ ...order, settlementTxHash: null }).settlement_tx_hash).toBeNull();
    expect(serializeOrderBase({ ...order }).settlement_tx_hash).toBeNull();
  });

  it('publishes exactly the keys it published before plus the settlement hash', () => {
    expect(KEYS_BEFORE).toHaveLength(34);
    expect(Object.keys(serializeOrderBase(order)).sort()).toEqual([...KEYS_BEFORE, 'settlement_tx_hash'].sort());
  });
});
