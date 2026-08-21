import { describe, it, expect } from 'vitest'
import { pillFor, tierLabel, tierBadgeClasses, nextTier, nextTierThreshold, formatUsdcAmount } from '../lib/format'

describe('pillFor', () => {
  it('CREATED/MATCHED still fall back to "Matching"', () => {
    expect(pillFor('CREATED')).toEqual({ tone: 'accent', label: 'Matching' })
    expect(pillFor('MATCHED')).toEqual({ tone: 'accent', label: 'Matching' })
  })
})

describe('tierLabel', () => {
  it('title-cases each tier', () => {
    expect(tierLabel('BRONZE')).toBe('Bronze')
    expect(tierLabel('SILVER')).toBe('Silver')
    expect(tierLabel('TRUSTED')).toBe('Trusted')
    expect(tierLabel('GOLD')).toBe('Gold')
  })
})

describe('tierBadgeClasses', () => {
  it('gives every tier a distinct, non-empty class string', () => {
    const classes = ['BRONZE', 'SILVER', 'TRUSTED', 'GOLD'].map((t) =>
      tierBadgeClasses(t as any),
    )
    for (const c of classes) expect(c.length).toBeGreaterThan(0)
    expect(new Set(classes).size).toBe(4)
  })

  it('GOLD uses the amber tokens, TRUSTED uses the accent tokens', () => {
    expect(tierBadgeClasses('GOLD')).toContain('lp-amber')
    expect(tierBadgeClasses('TRUSTED')).toContain('lp-accent')
  })
})

describe('nextTier / nextTierThreshold', () => {
  it('BRONZE -> SILVER at 5 completed trades', () => {
    expect(nextTier('BRONZE')).toBe('SILVER')
    expect(nextTierThreshold('BRONZE')).toBe(5)
  })

  it('SILVER -> TRUSTED at 20 completed trades', () => {
    expect(nextTier('SILVER')).toBe('TRUSTED')
    expect(nextTierThreshold('SILVER')).toBe(20)
  })

  it('TRUSTED -> GOLD at 50 completed trades', () => {
    expect(nextTier('TRUSTED')).toBe('GOLD')
    expect(nextTierThreshold('TRUSTED')).toBe(50)
  })

  it('GOLD is maxed — no next tier', () => {
    expect(nextTier('GOLD')).toBeNull()
    expect(nextTierThreshold('GOLD')).toBeNull()
  })
})

describe('formatUsdcAmount', () => {
  it('formats to 2dp with thousands grouping', () => {
    expect(formatUsdcAmount(1234.5)).toBe('1,234.50')
    expect(formatUsdcAmount(0)).toBe('0.00')
    expect(formatUsdcAmount(100)).toBe('100.00')
  })
})
