import { verifyTradeMatchesOrder, OrderBindingFields } from './trade-binding';
import { TradeOnChain } from '../stellar/stellar-read.types';

const USER = 'GUSER00000000000000000000000000000000000000000000000000A';
const LP = 'GLP000000000000000000000000000000000000000000000000000B';
const PLATFORM = 'GPLATFORM00000000000000000000000000000000000000000000C';

function topUpOrder(overrides: Partial<OrderBindingFields> = {}): OrderBindingFields {
  return {
    flow: 'TOP_UP',
    userAddress: USER,
    lpWallet: LP,
    usdcAmount: 1_000_0000000n,
    fiatAmount: 16_300_000n,
    fiatCurrency: 'IDR',
    platformFeeBps: 30,
    lpFeeBps: 120,
    platformWallet: PLATFORM,
    payDeadline: 1_800n,
    confirmDeadline: 3_600n,
    disputeDeadline: 10_800n,
    ...overrides,
  };
}

function matchingTrade(order: OrderBindingFields, overrides: Partial<TradeOnChain> = {}): TradeOnChain {
  const isTopUp = order.flow === 'TOP_UP';
  return {
    status: 'FUNDED',
    settledAt: 0,
    usdcAmount: order.usdcAmount,
    fiatAmount: order.fiatAmount,
    fiatCurrency: order.fiatCurrency,
    flow: isTopUp ? 0 : 1,
    usdcProvider: isTopUp ? order.lpWallet! : order.userAddress,
    usdcRecipient: isTopUp ? order.userAddress : order.lpWallet!,
    confirmer: isTopUp ? order.lpWallet! : order.userAddress,
    platformWallet: order.platformWallet,
    lpWallet: order.lpWallet!,
    platformFeeBps: order.platformFeeBps,
    lpFeeBps: order.lpFeeBps,
    payDeadline: order.payDeadline,
    confirmDeadline: order.confirmDeadline,
    disputeDeadline: order.disputeDeadline,
    ...overrides,
  };
}

describe('verifyTradeMatchesOrder', () => {
  it('accepts a trade that matches the order exactly', () => {
    const order = topUpOrder();
    expect(verifyTradeMatchesOrder(matchingTrade(order), order)).toEqual([]);
  });

  it('accepts a matching WITHDRAW trade with the roles reversed', () => {
    const order = topUpOrder({ flow: 'WITHDRAW' });
    const trade = matchingTrade(order);
    expect(trade.usdcProvider).toBe(USER);
    expect(trade.usdcRecipient).toBe(LP);
    expect(verifyTradeMatchesOrder(trade, order)).toEqual([]);
  });

  it('rejects the underfunded escrow — one base unit against a full-value order', () => {
    const order = topUpOrder();
    const mismatches = verifyTradeMatchesOrder(matchingTrade(order, { usdcAmount: 1n }), order);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('usdcAmount');
    expect(mismatches[0]).toContain('chain=1');
  });

  it('rejects an overfunded escrow just as firmly as an underfunded one', () => {
    const order = topUpOrder();
    const mismatches = verifyTradeMatchesOrder(
      matchingTrade(order, { usdcAmount: order.usdcAmount * 2n }),
      order,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('usdcAmount');
  });

  it('rejects a redirected usdcRecipient', () => {
    const order = topUpOrder();
    const attacker = 'GATTACKER000000000000000000000000000000000000000000000D';
    const mismatches = verifyTradeMatchesOrder(
      matchingTrade(order, { usdcRecipient: attacker }),
      order,
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('usdcRecipient');
  });

  it('rejects a redirected lpWallet, which receives the provider fee', () => {
    const order = topUpOrder();
    const attacker = 'GATTACKER000000000000000000000000000000000000000000000D';
    const mismatches = verifyTradeMatchesOrder(matchingTrade(order, { lpWallet: attacker }), order);
    expect(mismatches.some((m) => m.startsWith('lpWallet'))).toBe(true);
  });

  it('rejects a swapped usdcProvider and confirmer', () => {
    const order = topUpOrder();
    const mismatches = verifyTradeMatchesOrder(
      matchingTrade(order, { usdcProvider: USER, confirmer: USER }),
      order,
    );
    expect(mismatches.some((m) => m.startsWith('usdcProvider'))).toBe(true);
    expect(mismatches.some((m) => m.startsWith('confirmer'))).toBe(true);
  });

  it('rejects a mismatched fiat amount and currency', () => {
    const order = topUpOrder();
    const mismatches = verifyTradeMatchesOrder(
      matchingTrade(order, { fiatAmount: 1n, fiatCurrency: 'PHP' }),
      order,
    );
    expect(mismatches.some((m) => m.startsWith('fiatAmount'))).toBe(true);
    expect(mismatches.some((m) => m.startsWith('fiatCurrency'))).toBe(true);
  });

  it('rejects a flow discriminant that contradicts the order', () => {
    const order = topUpOrder();
    const mismatches = verifyTradeMatchesOrder(matchingTrade(order, { flow: 1 }), order);
    expect(mismatches.some((m) => m.startsWith('flow'))).toBe(true);
  });

  it('rejects tampered fees and platform wallet', () => {
    const order = topUpOrder();
    const mismatches = verifyTradeMatchesOrder(
      matchingTrade(order, { platformFeeBps: 0, lpFeeBps: 500, platformWallet: LP }),
      order,
    );
    expect(mismatches.some((m) => m.startsWith('platformFeeBps'))).toBe(true);
    expect(mismatches.some((m) => m.startsWith('lpFeeBps'))).toBe(true);
    expect(mismatches.some((m) => m.startsWith('platformWallet'))).toBe(true);
  });

  it('rejects tampered deadlines', () => {
    const order = topUpOrder();
    const mismatches = verifyTradeMatchesOrder(
      matchingTrade(order, { payDeadline: 999_999n }),
      order,
    );
    expect(mismatches.some((m) => m.startsWith('payDeadline'))).toBe(true);
  });

  it('fails closed when a field is absent from the decode', () => {
    const order = topUpOrder();
    const trade = matchingTrade(order);
    delete (trade as any).usdcAmount;
    const mismatches = verifyTradeMatchesOrder(trade, order);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('missing or undecodable');
  });

  it('fails closed on a bare status-only decode, reporting every field', () => {
    const order = topUpOrder();
    const mismatches = verifyTradeMatchesOrder({ status: 'FUNDED', settledAt: 0 }, order);
    expect(mismatches.map((m) => m.split(':')[0]).sort()).toEqual([
      'confirmDeadline',
      'confirmer',
      'disputeDeadline',
      'fiatAmount',
      'fiatCurrency',
      'flow',
      'lpFeeBps',
      'lpWallet',
      'payDeadline',
      'platformFeeBps',
      'platformWallet',
      'usdcAmount',
      'usdcProvider',
      'usdcRecipient',
    ]);
    expect(mismatches.every((m) => m.includes('missing or undecodable'))).toBe(true);
  });

  it('refuses to bind a trade to an order with no matched provider', () => {
    const order = topUpOrder({ lpWallet: null });
    const mismatches = verifyTradeMatchesOrder({ status: 'FUNDED', settledAt: 0 }, order);
    expect(mismatches).toEqual([
      'lpWallet: order has no matched provider, cannot bind an on-chain trade to it',
    ]);
  });

  it('accepts numeric and string encodings of the same amount', () => {
    const order = topUpOrder({ usdcAmount: 500n, payDeadline: 1800n });
    const trade = matchingTrade(order, { usdcAmount: 500 as any, payDeadline: '1800' as any });
    expect(verifyTradeMatchesOrder(trade, order)).toEqual([]);
  });
});
