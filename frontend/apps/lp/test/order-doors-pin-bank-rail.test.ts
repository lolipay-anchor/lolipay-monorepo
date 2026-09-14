import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..')

function read(relPath: string): string {
  return readFileSync(join(repoRoot, relPath), 'utf8')
}

describe('the dashboard hero trusts every order door to still create a BANK-rail order', () => {
  it('pins the three doors that decide whether "accepting orders" is true', () => {
    expect(read('frontend/apps/web/hooks/useQuote.ts')).toMatch(
      /createQuote\(client,\s*\{\s*flow:\s*'TOP_UP',\s*rail:\s*'BANK'/,
    )
    expect(read('frontend/apps/web/components/SellForm.tsx')).toMatch(
      /rail:\s*'BANK'\s+as const/,
    )
    expect(read('services/coordinator/src/sep24/sep24.service.ts')).toMatch(
      /createQuote\(accountOf\(row\.stellarAccount\),\s*row\.flow,\s*'BANK',/,
    )
  })
})
