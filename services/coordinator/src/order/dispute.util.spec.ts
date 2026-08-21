import { canDispute } from './dispute.util';

const CONFIG = { postSettleDisputeWindowSecs: 3600 };

describe('canDispute', () => {
  it('FIAT_PAID is always disputable, regardless of settledAt', () => {
    expect(canDispute({ status: 'FIAT_PAID', settledAt: null }, CONFIG)).toBe(true);
    expect(canDispute({ status: 'FIAT_PAID', settledAt: new Date(0) }, CONFIG)).toBe(true);
  });

  it.each(['RELEASED', 'REFUNDED'])(
    '%s within the post-settle window is disputable',
    (status) => {
      const settledAt = new Date(Date.now() - 60_000);
      expect(canDispute({ status, settledAt }, CONFIG)).toBe(true);
    },
  );

  it.each(['RELEASED', 'REFUNDED'])(
    '%s PAST the post-settle window is NOT disputable',
    (status) => {
      const settledAt = new Date(Date.now() - (CONFIG.postSettleDisputeWindowSecs + 60) * 1000);
      expect(canDispute({ status, settledAt }, CONFIG)).toBe(false);
    },
  );

  it('boundary: exactly at the window edge is still disputable (inclusive)', () => {
    const settledAt = new Date(Date.now() - CONFIG.postSettleDisputeWindowSecs * 1000);
    expect(canDispute({ status: 'RELEASED', settledAt }, CONFIG)).toBe(true);
  });

  it('boundary: one second past the window edge is NOT disputable', () => {
    const settledAt = new Date(Date.now() - (CONFIG.postSettleDisputeWindowSecs * 1000 + 1000));
    expect(canDispute({ status: 'RELEASED', settledAt }, CONFIG)).toBe(false);
  });

  it('RELEASED/REFUNDED with settledAt not yet stamped by the indexer → not disputable (fail closed, not a crash)', () => {
    expect(canDispute({ status: 'RELEASED', settledAt: null }, CONFIG)).toBe(false);
    expect(canDispute({ status: 'REFUNDED', settledAt: null }, CONFIG)).toBe(false);
  });

  it.each(['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'DISPUTED', 'EXPIRED', 'CANCELLED'])(
    '%s is never disputable',
    (status) => {
      expect(canDispute({ status, settledAt: null }, CONFIG)).toBe(false);
      expect(canDispute({ status, settledAt: new Date() }, CONFIG)).toBe(false);
    },
  );
});
