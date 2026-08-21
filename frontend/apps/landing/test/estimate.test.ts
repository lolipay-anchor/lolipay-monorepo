import { describe, it, expect } from 'vitest'
import { MARKETS, formatLocal } from '../lib/markets'
import { estimateBuy, estimateSell } from '../lib/estimate'

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
  it('buy: 0.3% fee off the USDC leg', () => {
    const { usdcNet, feeUsdc } = estimateBuy(500000, 16732)
    expect(usdcNet).toBeCloseTo((500000 / 16732) * 0.997, 6)
    expect(feeUsdc).toBeCloseTo((500000 / 16732) * 0.003, 6)
  })
  it('sell: 0.3% fee off the local leg', () => {
    const { localNet, feeLocal } = estimateSell(30, 16732)
    expect(localNet).toBeCloseTo(30 * 0.997 * 16732, 6)
    expect(feeLocal).toBeCloseTo(30 * 0.003 * 16732, 6)
  })
})
