import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LP_CAPACITY_LOST_SENTENCE, NO_PROVIDER_SENTENCE } from './interactive-sentence';

function flatMatchingService(): string {
  return readFileSync(join(__dirname, '../matching/matching.service.ts'), 'utf8').replace(/\s+/g, ' ');
}

describe('the no-provider sentence and the capacity-lost sentence each say only what their own throw site knows', () => {
  it('NO_PROVIDER_SENTENCE is pinned byte-for-byte, so a reword is deliberate and reviewed', () => {
    expect(NO_PROVIDER_SENTENCE).toBe(
      'This anchor could not match a provider to this order right now, and no money has moved. ' +
        'You can go back and try again, or come back later.',
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

  it('NO_PROVIDER_SENTENCE asserts no cause, since one of the predicates that reaches it is the amount itself', () => {
    expect(NO_PROVIDER_SENTENCE).not.toMatch(/not anything you did|nothing you entered/i);
  });

  it('pickLp still has exactly three continues feeding the throw that carries NO_PROVIDER_SENTENCE, so a new fall-through reaches this sentence and the sentence must be checked against it', () => {
    const flat = flatMatchingService();
    const start = flat.indexOf('async pickLp(');
    expect(start).toBeGreaterThan(-1);
    const end = flat.indexOf('NO_PROVIDER_SENTENCE', start);
    expect(end).toBeGreaterThan(start);
    const body = flat.slice(start, end);
    const sites: number[] = [];
    for (let at = body.indexOf('continue;'); at !== -1; at = body.indexOf('continue;', at + 1)) {
      sites.push(at);
    }
    expect(sites).toHaveLength(3);
  });
});
