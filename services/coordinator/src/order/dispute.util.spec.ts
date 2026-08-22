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
    const now = new Date('2026-08-22T12:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);
    try {
      const settledAt = new Date(now.getTime() - CONFIG.postSettleDisputeWindowSecs * 1000);
      expect(canDispute({ status: 'RELEASED', settledAt }, CONFIG)).toBe(true);

      const oneMsPast = new Date(settledAt.getTime() - 1);
      expect(canDispute({ status: 'RELEASED', settledAt: oneMsPast }, CONFIG)).toBe(false);
    } finally {
      jest.useRealTimers();
    }
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
