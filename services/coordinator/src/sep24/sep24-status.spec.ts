import { OrderStatus } from '../generated/prisma/client';
import { sep24Status, SEP24_EMITTED_STATUSES } from './sep24-status';

const at = (status: string) => sep24Status({ status } as any);

describe('what an escrow trade looks like to a wallet that only speaks SEP-24', () => {
  it('is incomplete before any order exists, because no quote has been made', () => {
    expect(sep24Status(null)).toBe('incomplete');
  });

  it('is incomplete while the anchor is still waiting on identity, and never pending', () => {
    expect(sep24Status(null)).toBe('incomplete');
  });

  it.each([
    ['CREATED', 'pending_anchor'],
    ['MATCHED', 'pending_anchor'],
    ['AWAITING_ONCHAIN', 'pending_anchor'],
    ['FIAT_PAID', 'pending_anchor'],
    ['DISPUTED', 'pending_anchor'],
  ])('reports %s as %s, because the anchor is the party with work to do', (order, sep) => {
    expect(at(order)).toBe(sep);
  });

  it('asks the user to send rupiah only once the escrow actually holds the USDC', () => {
    expect(at('FUNDED')).toBe('pending_user_transfer_start');
  });

  it('is completed only when the escrow released', () => {
    expect(at('RELEASED')).toBe('completed');
  });

  it('reports a refund as a refund', () => {
    expect(at('REFUNDED')).toBe('refunded');
  });

  it.each(['EXPIRED', 'CANCELLED'])(
    'reports %s as expired, the only terminal fit SEP-24 offers',
    (order) => {
      expect(at(order)).toBe('expired');
    },
  );

  describe('a withdrawal, where the user is the one who funds the escrow', () => {
    const wd = (status: string) => sep24Status({ status } as any, 'WITHDRAW');

    it.each([
      ['CREATED', 'pending_anchor'],
      ['MATCHED', 'pending_user'],
      ['AWAITING_ONCHAIN', 'pending_user'],
      ['FUNDED', 'pending_anchor'],
      ['FIAT_PAID', 'pending_user'],
      ['DISPUTED', 'pending_anchor'],
      ['RELEASED', 'completed'],
      ['REFUNDED', 'refunded'],
      ['EXPIRED', 'expired'],
      ['CANCELLED', 'expired'],
    ])('reports %s as %s', (order, sep) => {
      expect(wd(order)).toBe(sep);
    });

    it('never tells a wallet to send funds to withdraw_anchor_account, which this anchor does not have', () => {
      for (const status of ['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'DISPUTED', 'RELEASED', 'REFUNDED', 'EXPIRED', 'CANCELLED']) {
        expect(wd(status)).not.toBe('pending_user_transfer_start');
      }
    });

    it('never advertises pending_stellar, because no code path writes AWAITING_ONCHAIN and the popup still asks the user to sign there', () => {
      expect(SEP24_EMITTED_STATUSES).not.toContain('pending_stellar');
    });

    it('never reports on_hold, which the acceptance suite does not know', () => {
      expect(wd('DISPUTED')).not.toBe('on_hold');
      expect(SEP24_EMITTED_STATUSES).not.toContain('on_hold');
    });
  });

  it('never invents a status the acceptance suite does not accept', () => {
    const accepted = [
      'incomplete', 'pending_anchor', 'pending_external', 'pending_stellar',
      'pending_trust', 'pending_user', 'pending_user_transfer_start',
      'pending_user_transfer_complete', 'completed', 'refunded', 'expired',
      'no_market', 'too_small', 'too_large', 'error',
    ];
    for (const emitted of SEP24_EMITTED_STATUSES) {
      expect(accepted).toContain(emitted);
    }
  });

  it('has an answer for every order state, so a wallet is never told nothing', () => {
    const every = [
      'CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID',
      'RELEASED', 'REFUNDED', 'DISPUTED', 'EXPIRED', 'CANCELLED',
    ];
    for (const order of every) {
      expect(SEP24_EMITTED_STATUSES).toContain(at(order));
    }
  });

  it('refuses to guess at an order state it does not recognise', () => {
    expect(() => at('SOMETHING_NEW')).toThrow(/SOMETHING_NEW/);
  });

  describe('once the depositor tells lolipay they sent the rupiah, ADR 0059', () => {
    const claimedAt = new Date('2026-09-25T00:00:00.000Z');

    it('reports a TOP_UP order that is FUNDED and carries a claim as pending_anchor, never pending_external, leaving every other state exactly as before', () => {
      expect(sep24Status({ status: 'FUNDED', userClaimedPaidAt: claimedAt } as any, 'TOP_UP')).toBe('pending_anchor');
      for (const [status, expected] of [
        ['CREATED', 'pending_anchor'],
        ['MATCHED', 'pending_anchor'],
        ['AWAITING_ONCHAIN', 'pending_anchor'],
        ['FIAT_PAID', 'pending_anchor'],
        ['DISPUTED', 'pending_anchor'],
        ['RELEASED', 'completed'],
        ['REFUNDED', 'refunded'],
        ['EXPIRED', 'expired'],
        ['CANCELLED', 'expired'],
      ] as const) {
        expect(sep24Status({ status, userClaimedPaidAt: claimedAt } as any, 'TOP_UP')).toBe(expected);
      }
    });

    it('never lists the status the reference wallet stops polling on among the statuses this anchor emits', () => {
      expect(SEP24_EMITTED_STATUSES).not.toContain('pending_external');
    });
  });

  describe('the reference wallet ends its deposit poll at pending_external, completed or error, the endStatuses of stellar-demo-wallet pollDepositUntilComplete.ts at commit 55d4532d', () => {
    const walletEndStatuses = ['pending_external', 'completed', 'error'];
    const everyStatusButReleased = Object.values(OrderStatus).filter((status) => status !== 'RELEASED');
    const claimedAt = new Date('2026-09-25T00:00:00.000Z');

    it('takes its population from the schema enum, so a state added later is covered or must be classified', () => {
      expect(everyStatusButReleased).toEqual(['CREATED', 'MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'REFUNDED', 'DISPUTED', 'EXPIRED', 'CANCELLED']);
    });

    it.each(everyStatusButReleased)('never maps a %s deposit, claimed or not, into a status the wallet stops polling at', (status) => {
      for (const userClaimedPaidAt of [null, claimedAt]) {
        expect(walletEndStatuses).not.toContain(sep24Status({ status, userClaimedPaidAt }, 'TOP_UP'));
      }
    });

    it('does let the wallet stop once the escrow released, so the property above is not met by never reaching an end status', () => {
      expect(walletEndStatuses).toContain(at('RELEASED'));
    });
  });
});
