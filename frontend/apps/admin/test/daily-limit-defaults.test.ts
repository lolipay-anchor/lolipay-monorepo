import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { TIERS, DEFAULT_DAILY_LIMIT_USDC, limitsFromConfig, limitsToPatch } from '@/lib/daily-limit'

function coordinatorSource(): string {
  let dir = process.cwd()
  while (!existsSync(join(dir, 'services/coordinator'))) {
    const up = dirname(dir)
    if (up === dir) throw new Error(`no services/coordinator above ${process.cwd()}`)
    dir = up
  }
  return join(dir, 'services/coordinator/src/reputation/user-reputation.service.ts')
}

const COORDINATOR_SOURCE = coordinatorSource()

describe('daily limit defaults', () => {
  it('mirrors the coordinator constant this screen has no endpoint to read', () => {
    const src = readFileSync(COORDINATOR_SOURCE, 'utf8')
    const block = src.match(
      /const DEFAULT_DAILY_LIMIT_USDC: Record<UserTierName, number> = \{([^}]*)\}/,
    )
    expect(block).not.toBeNull()

    const fromCoordinator = Object.fromEntries(
      [...block![1].matchAll(/(\w+):\s*(\d+)/g)].map((m) => [m[1], Number(m[2])]),
    )
    expect(fromCoordinator).toEqual(DEFAULT_DAILY_LIMIT_USDC)
  })

  it('lists the same four tiers the coordinator validates against', () => {
    const src = readFileSync(COORDINATOR_SOURCE, 'utf8')
    const block = src.match(/const TIER_LEVELS = \[([^\]]*)\] as const/)
    expect(block).not.toBeNull()
    expect([...block![1].matchAll(/'(\w+)'/g)].map((m) => m[1])).toEqual([...TIERS])
  })

  it('fills every missing tier from its default and keeps the ones that are stored', () => {
    expect(limitsFromConfig({ SILVER: 42 })).toEqual({
      BRONZE: 100,
      SILVER: 42,
      TRUSTED: 600,
      GOLD: 2000,
    })
    expect(limitsFromConfig(null)).toEqual(DEFAULT_DAILY_LIMIT_USDC)
    expect(limitsFromConfig(undefined)).toEqual(DEFAULT_DAILY_LIMIT_USDC)
  })

  it('always emits all four tiers, whatever the object it is handed holds', () => {
    expect(Object.keys(limitsToPatch({ BRONZE: 1 } as never))).toEqual([...TIERS])
  })
})
