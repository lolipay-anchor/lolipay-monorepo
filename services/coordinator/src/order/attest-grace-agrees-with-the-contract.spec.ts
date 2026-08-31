import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTEST_GRACE_SECS, refundOpensAt } from './dispute.util';

describe('the grace the coordinator grants the attestor is the grace the chain grants it', () => {
  const source = readFileSync(
    join(__dirname, '../../../../contracts/escrow/src/lib.rs'),
    'utf8',
  );

  it('reads the same number out of the contract that this service compiles in', () => {
    const found = source.match(/pub const ATTEST_GRACE_SECS: u64 = (\d+);/);
    expect(found).not.toBeNull();
    expect(BigInt(found![1])).toBe(ATTEST_GRACE_SECS);
  });

  it('is the same number the contract uses to bound the attestor, not merely a constant it declares', () => {
    const markFiatPaid = source
      .split(/\n\s*pub fn /)
      .find((fn) => fn.startsWith('mark_fiat_paid('));
    expect(markFiatPaid).toBeDefined();
    expect(markFiatPaid).not.toContain('pub fn ');
    expect(markFiatPaid).toContain('FiatPaid { trade_id }');
    expect(markFiatPaid).toContain('} else if');

    const attestorBranch = markFiatPaid!
      .split('caller == cfg.fiat_attestor && trade.flow == Flow::TopUp')[1]
      ?.split('} else if')[0];
    expect(attestorBranch).toBeDefined();
    expect(attestorBranch).not.toBe(markFiatPaid);
    expect(attestorBranch).toContain(
      'core::cmp::min(trade.confirm_deadline, trade.pay_deadline + ATTEST_GRACE_SECS)',
    );
  });

  it('opens the permissionless refund at exactly the moment the attestor loses the trade', () => {
    const refund = source.split(/\n\s*pub fn /).find((fn) => fn.startsWith('refund('));
    expect(refund).toBeDefined();
    expect(refund).not.toContain('pub fn ');
    expect(refund).toContain('let opens_at =');
    expect(refund).toContain('} else {');

    const topUp = refund!.split('if trade.flow == Flow::TopUp')[1]?.split('} else {')[0];
    expect(topUp).toBeDefined();
    expect(topUp).not.toBe(refund);
    expect(topUp).toContain(
      'core::cmp::min(trade.confirm_deadline, trade.pay_deadline + ATTEST_GRACE_SECS)',
    );

    const otherwise = refund!.split('} else {')[1]?.split('};')[0];
    expect(otherwise).toBeDefined();
    expect(otherwise!.trim()).toBe('trade.confirm_deadline');

    const payDeadline = 1_000n;
    const confirmDeadline = 9_000n;
    expect(refundOpensAt({ flow: 'TOP_UP', payDeadline, confirmDeadline })).toBe(
      payDeadline + ATTEST_GRACE_SECS,
    );
    expect(refundOpensAt({ flow: 'WITHDRAW', payDeadline, confirmDeadline })).toBe(confirmDeadline);
  });
});
