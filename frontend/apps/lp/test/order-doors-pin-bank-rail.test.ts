import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

function read(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8')
}

describe('the dashboard hero trusts every first-party order door to still create a BANK-rail order', () => {
  it('pins the three doors that decide whether "accepting orders" is true', () => {
    expect.soft(
      read('frontend/apps/web/hooks/useQuote.ts'),
      'the top-up door must still request a BANK-rail quote — if this call moved or was parameterised, re-point this pin at the new call, do not loosen it: the dashboard withholds "accepting orders" from a QRIS-only provider on the strength of this',
    ).toMatch(
      /createQuote\(client,\s*\{\s*flow:\s*'TOP_UP',\s*rail:\s*'BANK'/,
    )
    expect.soft(
      read('frontend/apps/web/components/SellForm.tsx'),
      'the withdraw door must declare rail BANK inside CONFIG itself — this pattern is anchored to the CONFIG literal on purpose, so that a rail moved into dead code cannot satisfy it; if CONFIG was renamed or reshaped, re-point this pin, do not loosen it',
    ).toMatch(
      /const CONFIG = \{[^}]*rail:\s*'BANK'\s+as const/,
    )
    expect.soft(
      read('frontend/apps/web/components/SellForm.tsx'),
      'the withdraw door must pass CONFIG.rail through unchanged — if cfg moved or was wrapped, re-point this pin, do not loosen it: only this link catches const cfg = { ...CONFIG, rail: selectedRail }',
    ).toMatch(
      /^\s*const cfg = CONFIG\s*$/m,
    )
    expect.soft(
      read('frontend/apps/web/components/SellForm.tsx'),
      'the withdraw door must build its quote from cfg.flow and cfg.rail rather than from literals, so the two pins above still govern the rail it sends — if the call changed shape, re-point this pin, do not loosen it',
    ).toMatch(
      /createQuote\(client,\s*\{\s*flow:\s*cfg\.flow,\s*rail:\s*cfg\.rail/,
    )
    expect.soft(
      read('services/coordinator/src/sep24/sep24.service.ts'),
      'the SEP-24 door must still quote the BANK rail — if this call moved or the rail became a column, re-point this pin, do not loosen it: a provider with no BANK method is told orders cannot reach them because of it',
    ).toMatch(
      /createQuote\(accountOf\(row\.stellarAccount\),\s*row\.flow,\s*'BANK',/,
    )
  })
})
