import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

const OPTED_IN: Array<[string, string, number, string]> = [
  ['matching/matching.service.ts', "new ServiceUnavailableException('no eligible LP available')", 1, 'NO_PROVIDER_SENTENCE'],
  ['order/order.service.ts', "new ServiceUnavailableException('no eligible LP available')", 1, 'NO_PROVIDER_SENTENCE'],
  ['kyc/sep12.service.ts', "new ForbiddenException('this identity was refused and cannot be resubmitted here')", 2, 'IDENTITY_REFUSED_SENTENCE'],
];

function flattened(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8').replace(/\s+/g, ' ');
}

describe('every refusal this commit opted in still carries its marker at the throw', () => {
  it.each(OPTED_IN)(
    '%s wraps every %s, and there are %i of them, each handed %s',
    (relative, construction, expected, sentence) => {
      const flat = flattened(relative);
      const sites: number[] = [];
      for (let at = flat.indexOf(construction); at !== -1; at = flat.indexOf(construction, at + 1)) {
        sites.push(at);
      }
      expect(sites).toHaveLength(expected);
      for (const at of sites) {
        expect(flat.slice(0, at)).toMatch(/withInteractiveSentence\( $/);
        expect(flat.slice(at + construction.length)).toMatch(new RegExp(`^, ${sentence}[, )]`));
      }
    },
  );

  it('reads the source, so it proves the marker is written at the throw and not that it survives at runtime', () => {
    expect(flattened('matching/matching.service.ts')).toContain(
      "from '../sep24/interactive-sentence'",
    );
    expect(flattened('order/order.service.ts')).toContain("from '../sep24/interactive-sentence'");
    expect(flattened('kyc/sep12.service.ts')).toContain("from '../sep24/interactive-sentence'");
  });
});
