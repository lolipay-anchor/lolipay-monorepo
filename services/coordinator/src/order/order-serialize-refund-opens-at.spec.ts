import { serializeOrderBase } from './order.serialize';

const BASE = {
  id: 'o1',
  tradeId: 'a'.repeat(64),
  userAddress: 'GUSER',
  lpWallet: 'GLP',
  rail: 'BANK',
  usdcAmount: 100000000n,
  fiatAmount: 1600000n,
  fiatCurrency: 'IDR',
  rateSnapshot: '16000',
  platformFeeBps: 30,
  lpFeeBps: 120,
  status: 'FUNDED',
  disputeDeadline: 4_000_050_000n,
  expiresAt: new Date(3_999_999_400_000),
  createdAt: new Date(),
  settledAt: null,
};

describe('the order the coordinator serves carries refund_opens_at', () => {
  it('on a TOP_UP order where the attest grace binds (grace < confirm deadline), serves the grace instant', () => {
    const order = {
      ...BASE,
      flow: 'TOP_UP',
      payDeadline: 4_000_000_000n,
      confirmDeadline: 4_000_020_000n,
    };

    const json = serializeOrderBase(order);

    expect(json.refund_opens_at).toBe(4_000_003_600);
  });

  it('at a schema-default confirm window (1800s, less than ATTEST_GRACE_SECS 3600s) the confirm deadline binds instead of the grace', () => {
    const order = {
      ...BASE,
      flow: 'TOP_UP',
      payDeadline: 4_000_000_000n,
      confirmDeadline: 4_000_001_800n,
    };

    const json = serializeOrderBase(order);

    expect(json.refund_opens_at).toBe(4_000_001_800);
  });

  it('on a WITHDRAW order, serves the confirm deadline unchanged even where the attest grace would otherwise bind', () => {
    const order = {
      ...BASE,
      flow: 'WITHDRAW',
      payDeadline: 4_000_000_000n,
      confirmDeadline: 4_000_009_000n,
    };

    const json = serializeOrderBase(order);

    expect(json.refund_opens_at).toBe(4_000_009_000);
  });
});
