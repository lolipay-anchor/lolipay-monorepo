import { EVENT_STATUS } from './indexer.service';

describe('the indexer knows every way a trade can leave the contract', () => {
  it('treats an early release as a release', () => {
    expect(EVENT_STATUS.early_released).toBe('RELEASED');
  });

  it('maps every settling event the escrow can emit', () => {
    for (const name of ['trade_created', 'fiat_paid', 'released', 'early_released', 'refunded']) {
      expect(EVENT_STATUS[name]).toBeTruthy();
    }
  });
});
