import { describe, it, expect } from 'vitest'
import { formatIDR, formatUSDC, parseIDRInput } from '../lib/money'
describe('money', () => {
  it('formats IDR with thousands separators', () => {
    expect(formatIDR(1624000)).toBe('Rp 1.624.000')
    expect(formatIDR(0)).toBe('Rp 0')
  })
  it('formats USDC base units (7dp) to 2dp display', () => {
    expect(formatUSDC(1000000000n)).toBe('100.00')
    expect(formatUSDC(985000000n)).toBe('98.50')
  })
  it('parses grouped IDR input back to number', () => {
    expect(parseIDRInput('Rp 1.624.000')).toBe(1624000)
    expect(parseIDRInput('250000')).toBe(250000)
  })
})
