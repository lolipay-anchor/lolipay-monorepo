import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const EXCLUDED_TOP_LEVEL_DIRS = new Set(['generated', 'scripts']);

const ALLOWED_READERS = new Set(['order/order.serialize.ts', 'sep24/sep24-transaction.ts']);

function collectSourceFiles(root: string, relPath: string): string[] {
  const abs = join(root, relPath);
  const info = statSync(abs);
  if (info.isFile()) {
    if (!abs.endsWith('.ts') || abs.includes('.spec.ts') || abs.includes('.e2e-spec.ts')) return [];
    return [abs];
  }
  return readdirSync(abs).flatMap((entry) => {
    if (relPath === '' && EXCLUDED_TOP_LEVEL_DIRS.has(entry)) return [];
    const entryRel = relPath === '' ? entry : join(relPath, entry);
    return collectSourceFiles(root, entryRel);
  });
}

describe('userClaimedPaidAt is an unsigned, display-only claim — nothing that decides money or capacity may read it, ANYWHERE in src', () => {
  const srcRoot = join(__dirname, '..');
  const allFiles = collectSourceFiles(srcRoot, '');
  const files = allFiles.filter((f) => !ALLOWED_READERS.has(relative(srcRoot, f)));

  it('found source files to guard, so a broken scan cannot pass silently', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('the search is proven live by finding payDeadline somewhere in the guarded tree', () => {
    const combined = files.map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(combined).toContain('payDeadline');
  });

  it.each(
    [
      'order/order.service.ts',
      'admin/admin.service.ts',
      'order/dispute.util.ts',
      'order/trade-binding.ts',
      'matching/matching.service.ts',
      'lp/lp.service.ts',
      'monitoring/monitoring.conditions.ts',
    ].map((p): [string] => [p]),
  )('%s is actually included in the guarded set, not just the traced six', (relPath) => {
    expect(files.map((f) => relative(srcRoot, f))).toContain(relPath);
  });

  it('order/order.service.ts is NOT on the allow-list — a future writer must live in its own file', () => {
    expect(ALLOWED_READERS.has('order/order.service.ts')).toBe(false);
  });

  it.each(files.map((f): [string, string] => [relative(srcRoot, f), f]))(
    '%s does not read userClaimedPaidAt',
    (_relPath, file) => {
      expect(readFileSync(file, 'utf8')).not.toContain('userClaimedPaidAt');
    },
  );

  it.each([...ALLOWED_READERS])('the allow-listed file %s exists, so it is excluded and not merely absent', (relPath) => {
    expect(statSync(join(srcRoot, relPath)).isFile()).toBe(true);
  });
});
