import { LP_CAPACITY_LOST_SENTENCE, NO_PROVIDER_SENTENCE } from './interactive-sentence';

describe('the no-provider sentence and the capacity-lost sentence each say only what their own throw site knows', () => {
  it('NO_PROVIDER_SENTENCE names no cause and no duration, because the fall-through it wraps never evaluated the amount and cannot promise a wait', () => {
    expect(NO_PROVIDER_SENTENCE).toBe(
      'This anchor could not match a provider to this order right now. ' +
        'It is not anything you did, and no money has moved. ' +
        'You can go back and try again, or come back to this page later.',
    );
  });

  it('LP_CAPACITY_LOST_SENTENCE names the lost headroom, because that throw site knows exactly why it fired', () => {
    expect(LP_CAPACITY_LOST_SENTENCE).toBe(
      'The provider this anchor matched you with no longer has room for this order. ' +
        'Nothing you entered was wrong and no money has moved. ' +
        'Go back and submit again — this anchor will look for another provider.',
    );
  });

  it('are two distinct strings, so a caller cannot confuse one throw site for the other', () => {
    expect(NO_PROVIDER_SENTENCE).not.toBe(LP_CAPACITY_LOST_SENTENCE);
  });
});
