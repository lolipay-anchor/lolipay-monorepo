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

const TOP_LEVEL_SOURCE_DIRS = [
  'admin',
  'anchor',
  'auth',
  'config',
  'email',
  'indexer',
  'kyc',
  'lp',
  'maintenance',
  'market',
  'matching',
  'money',
  'monitoring',
  'notification',
  'order',
  'outbox',
  'person',
  'prisma',
  'profile',
  'rate',
  'realtime',
  'reputation',
  'scripts',
  'sep10',
  'sep24',
  'stellar',
  'storage',
];

const USER_CLAIMED_PAID_AT_ALLOWED_READERS = [
  'sep24/interactive-page.ts',
  'sep24/sep24-status.ts',
  'sep24/sep24-transaction.ts',
  'sep24/sep24.service.ts',
];

const USER_CLAIMED_PAID_AT_DENIED_READERS = [
  'monitoring/monitoring.conditions.ts',
  'indexer/indexer.service.ts',
  'order/order-tx.service.ts',
  'admin/admin.service.ts',
];

const USER_CLAIMED_PAID_AT_FORBIDDEN_ALLOWLIST_ADDITIONS = [
  'order/test-helpers.ts',
  'auth/auth-test-helpers.ts',
  'storage/object-storage.fake.ts',
  'kyc/stub-kyc-provider.ts',
  'scripts/sep24-fixtures.ts',
  'order/order.serialize.ts',
];

describe('userClaimedPaidAt is an unsigned, display-only claim — every LITERAL occurrence of the identifier in non-test src is guarded here; a full-row Prisma read that returns the field without ever naming it (such as admin/admin.service.ts listOrders(), which has no select) is invisible to this scan and is not covered by it', () => {
  const srcRoot = join(__dirname, '..');
  const files = collectSourceFiles(srcRoot, '');
  const relFiles = files.map((f) => relative(srcRoot, f));

  it.each(TOP_LEVEL_SOURCE_DIRS.map((d): [string] => [d]))(
    'the guarded set includes at least one file from src/%s, so a narrowed scan is caught by directory rather than by a file count that churns on unrelated deletions',
    (dir) => {
      expect(relFiles.some((f) => f.startsWith(`${dir}/`))).toBe(true);
    },
  );

  it('the guarded set never includes a file from src/generated, named here as a literal rather than read from the scan\'s own exclusion list, so this assertion can witness that exclusion breaking', () => {
    expect(relFiles.some((f) => f.startsWith('generated/'))).toBe(false);
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

  it.each(USER_CLAIMED_PAID_AT_ALLOWED_READERS.map((p): [string] => [p]))(
    'allowlisted reader %s is present in the guarded set, so deleting the file (not just the identifier inside it) also reddens the equality check below rather than silently shrinking the row count',
    (relPath) => {
      expect(relFiles).toContain(relPath);
    },
  );

  it.each(files.map((f): [string, string] => [relative(srcRoot, f), f]))(
    '%s reads userClaimedPaidAt if, and only if, it is one of the four allowlisted sep24 readers — an EQUALITY check, not a subset check: a new reader anywhere reddens this row because the set grew, and a listed reader that stops reading it also reddens its own row because the set shrank',
    (relPath, file) => {
      const readsClaim = readFileSync(file, 'utf8').includes('userClaimedPaidAt');
      expect(readsClaim).toBe(USER_CLAIMED_PAID_AT_ALLOWED_READERS.includes(relPath));
    },
  );

  it.each(USER_CLAIMED_PAID_AT_DENIED_READERS.map((p): [string] => [p]))(
    '%s is denied as a LITERAL, independent of the allowlist array above, so this assertion can witness its own exclusion breaking the same way the generated/ check above does; the admin/admin.service.ts row is a STRING denial only — listOrders() is a full-row findMany with no select, so it hands this column to the controller without any file naming it, and what keeps it off the admin API is serializeOrderBase being an explicit field allowlist that does not carry it',
    (relPath) => {
      expect(readFileSync(join(srcRoot, relPath), 'utf8')).not.toContain('userClaimedPaidAt');
    },
  );

  it.each(USER_CLAIMED_PAID_AT_FORBIDDEN_ALLOWLIST_ADDITIONS.map((p): [string] => [p]))(
    '%s is present in the guarded set and must never be added to USER_CLAIMED_PAID_AT_ALLOWED_READERS, because allowlisting any of them would permanently license a non-sep24 file to read the column: the shared fixtures because they are non-spec, non-generated files this scan does not exclude and a claim-carrying fixture belongs in the spec file that needs it, and order/order.serialize.ts because lolipay own web app already ships a SIGNED I-have-paid with opposite powers and the unsigned claim deliberately does not reach that surface',
    (relPath) => {
      expect(relFiles).toContain(relPath);
      expect(USER_CLAIMED_PAID_AT_ALLOWED_READERS).not.toContain(relPath);
    },
  );
});
