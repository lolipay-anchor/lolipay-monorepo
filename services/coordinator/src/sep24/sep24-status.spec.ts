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
      ['AWAITING_ONCHAIN', 'pending_stellar'],
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
});
