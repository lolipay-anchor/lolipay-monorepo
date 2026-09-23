import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const GUARDED_PATHS = [
  'maintenance',
  'order/order-status.service.ts',
  'order/order-tx.service.ts',
  'indexer',
  'order/lp-exposure.ts',
  'stellar/refund-signer.service.ts',
];

function collectSourceFiles(root: string, relPath: string): string[] {
  const abs = join(root, relPath);
  const info = statSync(abs);
  if (info.isFile()) return [abs];
  return readdirSync(abs).flatMap((entry) => {
    const entryRel = join(relPath, entry);
    const entryAbs = join(root, entryRel);
    if (statSync(entryAbs).isDirectory()) return collectSourceFiles(root, entryRel);
    if (!entry.endsWith('.ts') || entry.includes('.spec.ts') || entry.includes('.e2e-spec.ts')) return [];
    return [entryAbs];
  });
}

describe('userClaimedPaidAt is an unsigned, display-only claim — nothing that decides money or capacity may read it', () => {
  const srcRoot = join(__dirname, '..');
  const files = GUARDED_PATHS.flatMap((p) => collectSourceFiles(srcRoot, p));

  it('found source files to guard, so an empty GUARDED_PATHS entry cannot pass silently', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('the search is proven live by finding payDeadline, and none of the guarded files read userClaimedPaidAt', () => {
    const combined = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(combined).toContain('payDeadline');
    expect(combined).not.toContain('userClaimedPaidAt');
  });

  it.each(files.map((f): [string, string] => [relative(srcRoot, f), f]))(
    '%s does not read userClaimedPaidAt',
    (_relPath, file) => {
      expect(readFileSync(file, 'utf8')).not.toContain('userClaimedPaidAt');
    },
  );
});
