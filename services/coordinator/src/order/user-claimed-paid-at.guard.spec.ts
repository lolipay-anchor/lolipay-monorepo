import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';

const EXCLUDED_TOP_LEVEL_DIRS = new Set(['generated']);

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

describe('userClaimedPaidAt is an unsigned, display-only claim — every LITERAL occurrence of the identifier in hand-written src is guarded here; a full-row Prisma read that returns the field without ever naming it (such as admin/admin.service.ts listOrders(), which has no select) is invisible to this scan and is not covered by it', () => {
  const srcRoot = join(__dirname, '..');
  const files = collectSourceFiles(srcRoot, '');

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

  it.each(files.map((f): [string, string] => [relative(srcRoot, f), f]))(
    '%s does not read userClaimedPaidAt',
    (_relPath, file) => {
      expect(readFileSync(file, 'utf8')).not.toContain('userClaimedPaidAt');
    },
  );
});
