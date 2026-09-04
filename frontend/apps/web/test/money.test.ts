import { describe, it, expect } from 'vitest'
import { formatIDR, formatUSDC, parseIDRInput, idrInputAccepted, usdcBaseUnitsFor } from '../lib/money'
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
    expect(parseIDRInput('rp 1.500.000')).toBe(1500000)
  })

  it.each(['200000,50', '150000.00', '1,5', '2e5', '-150000', '200 000', 'abc'])('refuses "%s" rather than guessing what it means, the same rule the anchor applies', (raw) => {
    expect(idrInputAccepted(raw)).toBe(false)
    expect(parseIDRInput(raw)).toBe(0)
  })

  it('accepts the two forms an Indonesian types', () => {
    expect(idrInputAccepted('200000')).toBe(true)
    expect(idrInputAccepted('Rp 200.000')).toBe(true)
  })

  it('refuses an empty field and more than eighteen digits, the bound the anchor applies, so the quote arithmetic never sees a number it cannot hold', () => {
    expect(idrInputAccepted('')).toBe(false)
    expect(idrInputAccepted('9'.repeat(19))).toBe(false)
    expect(parseIDRInput('9'.repeat(19))).toBe(0)
    expect(idrInputAccepted('9'.repeat(18))).toBe(true)
  })
})

describe('usdcBaseUnitsFor turns a rupiah amount into USDC base units without ever handing BigInt a number it cannot read', () => {
  it('rounds to the nearest base unit at the live shape of rate', () => {
    expect(usdcBaseUnitsFor(1624000, 16000)).toBe('1015000000')
  })

  it('answers 0 when the product would leave the safe-integer range, where String() turns exponential and BigInt() throws', () => {
    expect(usdcBaseUnitsFor(1e20, 16000)).toBe('0')
    expect(usdcBaseUnitsFor(1e18, 1)).toBe('0')
  })

  it('answers 0 for a zero, negative or unreadable rate rather than dividing by it', () => {
    expect(usdcBaseUnitsFor(1624000, 0)).toBe('0')
    expect(usdcBaseUnitsFor(1624000, Number.NaN)).toBe('0')
  })
})
