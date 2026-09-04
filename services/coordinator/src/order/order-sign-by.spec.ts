import { serializeOrderBase } from './order.serialize';
import { signingCutoffSecs } from '../config/contract-limits';

describe('an order tells its reader the last instant the coordinator accepts the funding signature', () => {
  const order: any = {
    id: 'o1',
    tradeId: 'a'.repeat(64),
    userAddress: 'GUSER',
    lpWallet: 'GLP',
    flow: 'WITHDRAW',
    rail: 'BANK',
    usdcAmount: 100000000n,
    fiatAmount: 1600000n,
    fiatCurrency: 'IDR',
    rateSnapshot: '16000',
    platformFeeBps: 30,
    lpFeeBps: 120,
    status: 'MATCHED',
    payDeadline: 4_000_000_000n,
    confirmDeadline: 4_000_001_800n,
    disputeDeadline: 4_000_009_000n,
    expiresAt: new Date(3_999_999_400_000),
    createdAt: new Date(),
  };

  it('publishes sign_by as the cut-off the funding build refuses at, a minute before the contract instant expires_at marks', () => {
    const json = serializeOrderBase(order);
    expect(json.sign_by).toBe(signingCutoffSecs(4_000_000_000));
    expect(json.sign_by).toBe(3_999_999_340);
    expect(json.expires_at).toEqual(order.expiresAt);
  });
});
