import { canDispute, isOwnEvidencePath, postSettleDeadlineMs, postSettleDisputeDeadline, refundOpensAt } from './dispute.util';

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

describe('the window a trade settled under is the window it is judged by', () => {
  const CONFIG_WIDE = { postSettleDisputeWindowSecs: 604_800 };
  const settledAt = new Date(Date.now() - 7200 * 1000);
  const latched = BigInt(Math.floor(settledAt.getTime() / 1000) + 3600);

  it('refuses a dispute past the latched deadline even after the config is widened', () => {
    expect(canDispute({ status: 'RELEASED', settledAt, postSettleDeadline: latched }, CONFIG_WIDE)).toBe(
      false,
    );
    expect(canDispute({ status: 'RELEASED', settledAt }, CONFIG_WIDE)).toBe(true);
  });

  it('quotes the latched deadline rather than recomputing it', () => {
    const open = BigInt(Math.floor(Date.now() / 1000) + 1800);
    expect(
      postSettleDisputeDeadline(
        { status: 'RELEASED', settledAt, disputeBy: null, postSettleDeadline: open },
        { postSettleDisputeWindowSecs: 1 },
      ),
    ).toBe(new Date(Number(open) * 1000).toISOString());
  });

  it('falls back to the configured window only when the chain never told us', () => {
    const recent = new Date(Date.now() - 60 * 1000);
    expect(
      postSettleDisputeDeadline(
        { status: 'RELEASED', settledAt: recent, disputeBy: null },
        { postSettleDisputeWindowSecs: 3600 },
      ),
    ).toBe(new Date(recent.getTime() + 3600 * 1000).toISOString());
  });
});

describe('refundOpensAt matches the escrow', () => {
  it('waits for the confirm deadline on a withdrawal', () => {
    expect(
      refundOpensAt({ flow: 'WITHDRAW', payDeadline: 1000n, confirmDeadline: 2000n }),
    ).toBe(2000n);
  });

  it('takes the earlier of the grace and the confirm deadline on a deposit', () => {
    expect(refundOpensAt({ flow: 'TOP_UP', payDeadline: 1000n, confirmDeadline: 9000n })).toBe(4600n);
    expect(refundOpensAt({ flow: 'TOP_UP', payDeadline: 1000n, confirmDeadline: 2000n })).toBe(2000n);
  });

  it('never opens before the party who must pay has run out of time', () => {
    for (const flow of ['TOP_UP', 'WITHDRAW']) {
      for (const confirm of [1001n, 2000n, 4600n, 90_000n]) {
        expect(refundOpensAt({ flow, payDeadline: 1000n, confirmDeadline: confirm })).toBeGreaterThan(
          1000n,
        );
      }
    }
  });
});

describe('a latched zero is the pre-settlement sentinel, not a closed window', () => {
  it('falls back to the configured window when the chain reports zero', () => {
    const settledAt = new Date(Date.now() - 60_000);
    expect(
      postSettleDeadlineMs({ settledAt, postSettleDeadline: 0n }, { postSettleDisputeWindowSecs: 3600 }),
    ).toBe(settledAt.getTime() + 3600 * 1000);
  });

  it('still allows a dispute rather than reporting the window already shut', () => {
    const settledAt = new Date(Date.now() - 60_000);
    expect(
      canDispute({ status: 'RELEASED', settledAt, postSettleDeadline: 0n }, { postSettleDisputeWindowSecs: 3600 }),
    ).toBe(true);
  });
});

describe('a filing closes the post-settlement window for everyone', () => {
  const config = { postSettleDisputeWindowSecs: 7200 };
  const settled = new Date(Date.now() - 60_000);

  it('reports no window once anyone has filed, because there is no second filing', () => {
    expect(
      postSettleDisputeDeadline(
        { status: 'RELEASED', settledAt: settled, disputeBy: 'lp', disputeReason: 'WRONG_AMOUNT' },
        config,
      ),
    ).toBeNull();
  });

  it('reports no window even when the filing carries no reason, since it cannot be refilled', () => {
    expect(
      postSettleDisputeDeadline(
        { status: 'RELEASED', settledAt: settled, disputeBy: 'lp', disputeReason: null },
        config,
      ),
    ).toBeNull();
  });

  it('still reports the window while nobody has filed', () => {
    expect(
      postSettleDisputeDeadline(
        { status: 'RELEASED', settledAt: settled, disputeBy: null, disputeReason: null },
        config,
      ),
    ).not.toBeNull();
  });
});

describe('an evidence path belongs to the round it was uploaded in', () => {
  const closedAt = new Date(1_700_000_000_000);

  it('accepts the plain key while no round has been closed', () => {
    expect(isOwnEvidencePath('evidence/order-1-user.jpg', 'order-1', 'user', null)).toBe(true);
  });

  it('accepts only the key carrying the closed-round marker once a round has been closed', () => {
    expect(isOwnEvidencePath('evidence/order-1-user-1700000000000.jpg', 'order-1', 'user', closedAt)).toBe(true);
    expect(isOwnEvidencePath('evidence/order-1-user.jpg', 'order-1', 'user', closedAt)).toBe(false);
  });

  it('refuses a marked key while no round has been closed', () => {
    expect(isOwnEvidencePath('evidence/order-1-user-1700000000000.jpg', 'order-1', 'user', null)).toBe(false);
  });

  it('refuses the other party\'s marked key', () => {
    expect(isOwnEvidencePath('evidence/order-1-lp-1700000000000.jpg', 'order-1', 'user', closedAt)).toBe(false);
  });
});
