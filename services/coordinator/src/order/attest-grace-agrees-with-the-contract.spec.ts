import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ATTEST_GRACE_SECS } from './dispute.util';

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
    expect(markFiatPaid).not.toContain('release_from_funded');

    const attestorBranch = markFiatPaid!
      .split('caller == cfg.fiat_attestor && trade.flow == Flow::TopUp')[1]
      ?.split('} else if')[0];
    expect(attestorBranch).toBeDefined();
    expect(attestorBranch).toContain(
      'core::cmp::min(trade.confirm_deadline, trade.pay_deadline + ATTEST_GRACE_SECS)',
    );
  });
});
