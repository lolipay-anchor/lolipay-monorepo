import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { acceptedForFunds } from './screening-requirement';

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === 'generated' ? [] : sourceFiles(p);
    return /\.ts$/.test(name) && !/\.(spec|e2e-spec)\.ts$/.test(name) ? [p] : [];
  });
}

describe('whether a customer may move funds depends on one predicate that reads KYC_REQUIRE_AML', () => {
  it('demands a completed screening when AML is required, and identity acceptance alone when it is not', () => {
    expect(acceptedForFunds(true)).toEqual({ status: 'ACCEPTED', screenedAt: { not: null } });
    expect(acceptedForFunds(false)).toEqual({ status: 'ACCEPTED' });
  });

  it('is the only place the screening clause is spelled, so no gate can require AML behind the switch', () => {
    const offenders = sourceFiles(join(__dirname, '..'))
      .filter((p) => !p.endsWith('screening-requirement.ts'))
      .filter((p) => /screenedAt:\s*\{\s*not:\s*null\s*\}/.test(readFileSync(p, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
