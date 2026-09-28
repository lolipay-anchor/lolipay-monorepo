import { describe, it, expect } from 'vitest'
import { MARKETS, formatLocal } from '../lib/markets'
import { estimateBuy } from '../lib/estimate'

const ANCHOR_DEPOSIT_FEE_PERCENT = 1.5

describe('markets', () => {
  it('has the 6 handoff markets and only IDR enabled', () => {
    expect(MARKETS.map(m => m.code)).toEqual(['IDR', 'PHP', 'VND', 'INR', 'THB', 'BRL'])
    expect(MARKETS.filter(m => m.enabled).map(m => m.code)).toEqual(['IDR'])
    expect(MARKETS[0]).toMatchObject({ country: 'Indonesia', symbol: 'Rp', rail: 'QRIS', locale: 'id-ID' })
  })
  it('formats local amounts per market locale', () => {
    expect(formatLocal(500000, MARKETS[0])).toBe('Rp 500.000')
    expect(formatLocal(58.5, MARKETS[1])).toBe('₱ 58.50')
  })
})

describe('estimate', () => {
  it('buy: takes the fee percent it is given off the USDC leg', () => {
    const { usdcNet, feeUsdc } = estimateBuy(500000, 16732, ANCHOR_DEPOSIT_FEE_PERCENT)
    expect(usdcNet).toBeCloseTo((500000 / 16732) * (1 - ANCHOR_DEPOSIT_FEE_PERCENT / 100), 6)
    expect(feeUsdc).toBeCloseTo((500000 / 16732) * (ANCHOR_DEPOSIT_FEE_PERCENT / 100), 6)
  })
  it('the fee is the argument, not a constant: distinct fees give distinct quotes', () => {
    for (const pct of [1.5, 2.5]) {
      expect(estimateBuy(500000, 16000, pct).feeUsdc).toBeCloseTo((500000 / 16000) * (pct / 100), 6)
      expect(estimateBuy(500000, 16000, pct).usdcNet).toBeCloseTo((500000 / 16000) * (1 - pct / 100), 6)
    }
    expect(estimateBuy(500000, 16000, 1.5).feeUsdc).not.toBeCloseTo(estimateBuy(500000, 16000, 2.5).feeUsdc, 6)
  })

  it('a zero rate yields nothing rather than dividing by zero', () => {
    expect(estimateBuy(500000, 0, ANCHOR_DEPOSIT_FEE_PERCENT)).toEqual({ usdcNet: 0, feeUsdc: 0 })
  })
})
