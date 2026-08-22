import { userLostDispute, providerLostDispute } from './dispute-outcome';

describe('who lost the dispute', () => {
  const cases: [string, 'released' | 'refunded', 'user' | 'provider'][] = [
    ['TOP_UP', 'refunded', 'user'],
    ['TOP_UP', 'released', 'provider'],
    ['WITHDRAW', 'released', 'user'],
    ['WITHDRAW', 'refunded', 'provider'],
  ];

  it.each(cases)('%s resolved %s → %s loses', (flow, resolution, loser) => {
    expect(userLostDispute(flow, resolution)).toBe(loser === 'user');
    expect(providerLostDispute(flow, resolution)).toBe(loser === 'provider');
  });

  it('never blames both parties for the same outcome', () => {
    for (const [flow, resolution] of cases.map(([f, r]) => [f, r] as const)) {
      expect(userLostDispute(flow, resolution) && providerLostDispute(flow, resolution)).toBe(false);
    }
  });

  it('always blames exactly one party, so no outcome goes unrecorded', () => {
    for (const [flow, resolution] of cases.map(([f, r]) => [f, r] as const)) {
      expect(userLostDispute(flow, resolution) || providerLostDispute(flow, resolution)).toBe(true);
    }
  });
});
