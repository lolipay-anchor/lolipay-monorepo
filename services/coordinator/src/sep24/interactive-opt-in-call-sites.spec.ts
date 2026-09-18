import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

const OPTED_IN: Array<[string, string, number, string]> = [
  ['matching/matching.service.ts', "new ServiceUnavailableException('no eligible LP available')", 1, 'NO_PROVIDER_SENTENCE'],
  ['order/order.service.ts', "new ServiceUnavailableException('no eligible LP available')", 1, 'LP_CAPACITY_LOST_SENTENCE'],
  ['order/order.service.ts', 'new BadRequestException(PAYMENT_DESTINATION_MISSING_SENTENCE)', 1, 'PAYMENT_DESTINATION_MISSING_SENTENCE'],
  ['order/order.service.ts', 'new BadRequestException(PAYMENT_DESTINATION_TOO_LONG_SENTENCE)', 1, 'PAYMENT_DESTINATION_TOO_LONG_SENTENCE'],
  ['order/order.service.ts', 'new BadRequestException(PAYMENT_DESTINATION_BAD_CHARS_SENTENCE)', 1, 'PAYMENT_DESTINATION_BAD_CHARS_SENTENCE'],
  ['order/order.service.ts', 'new BadRequestException(PAYMENT_DESTINATION_TOO_SHORT_SENTENCE)', 1, 'PAYMENT_DESTINATION_TOO_SHORT_SENTENCE'],
  ['kyc/sep12.service.ts', "new ForbiddenException('this identity was refused and cannot be resubmitted here')", 2, 'IDENTITY_REFUSED_SENTENCE'],
];

function everySourceFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return e.name === 'generated' ? [] : everySourceFile(full);
    return e.name.endsWith('.ts') && !e.name.includes('.spec.') ? [full] : [];
  });
}

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

  it('opts in exactly the four amount-step refusals that already speak to the person, and nothing anywhere else', () => {
    const amountStep = flattened('sep24/sep24.service.ts');
    expect(amountStep.split('throw withOwnSentence(').length - 1).toBe(4);
    const elsewhere = everySourceFile(SRC).filter(
      (f) => !f.endsWith('sep24/sep24.service.ts') && !f.endsWith('sep24/interactive-sentence.ts'),
    );
    expect(elsewhere.length).toBeGreaterThan(50);
    for (const f of elsewhere) {
      expect(readFileSync(f, 'utf8')).not.toContain('withOwnSentence(');
    }
  });

  it('builds the one page it ever builds under the title the status chose, so no opt-in can reach the popup chrome', () => {
    const filter = flattened('sep24/interactive-error.filter.ts');
    expect(filter.split('page(').length - 1).toBe(1);
    expect(filter).toContain('page(told.title, ');
  });

  it('reads the source, so it proves the marker is written at the throw and not that it survives at runtime', () => {
    expect(flattened('matching/matching.service.ts')).toContain(
      "from '../sep24/interactive-sentence'",
    );
    expect(flattened('order/order.service.ts')).toContain("from '../sep24/interactive-sentence'");
    expect(flattened('kyc/sep12.service.ts')).toContain("from '../sep24/interactive-sentence'");
  });
});
