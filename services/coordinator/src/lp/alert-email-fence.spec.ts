import { readFileSync } from 'fs';
import { join } from 'path';

const PROVIDER_PATH_FILES = ['lp/lp.service.ts', 'maintenance/maintenance.service.ts'];
const PERSON_EMAIL_PATTERN = /\bperson\b.{0,30}\bemail\b/i;

function matchingLines(relPath: string): string[] {
  return readFileSync(join(__dirname, '..', relPath), 'utf8')
    .split('\n')
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => PERSON_EMAIL_PATTERN.test(line))
    .map(({ line, n }) => `${relPath}:${n}: ${line}`);
}

describe('ADR 0054, narrowed — Person.email is not read on the provider-only reachability path (lp.service.ts, maintenance.service.ts)', () => {
  it('reads zero lines matching person…email on the provider-only path — a sixth occurrence fails this test until it is consciously reviewed', () => {
    const hits = PROVIDER_PATH_FILES.flatMap(matchingLines);
    expect(hits).toEqual([]);
  });

  it("control: the unrelated WalletLink.person relation include in person.service.ts is untouched — still 2, proving the fence's pattern is scoped and did not need to sweep this file too", () => {
    const hits = readFileSync(join(__dirname, '..', 'person/person.service.ts'), 'utf8')
      .split('\n')
      .filter((line) => /include:\s*\{\s*person:\s*true\s*\}/.test(line));
    expect(hits).toHaveLength(2);
  });
});
