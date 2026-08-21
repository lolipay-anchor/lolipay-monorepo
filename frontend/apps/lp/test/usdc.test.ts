import { describe, it, expect } from 'vitest'
import { usdcToBaseUnits } from '@/lib/usdc'

describe('usdcToBaseUnits', () => {
  it('"100" → "1000000000"', () => {
    expect(usdcToBaseUnits('100')).toBe('1000000000')
  })

  it('"0.5" → "5000000"', () => {
    expect(usdcToBaseUnits('0.5')).toBe('5000000')
  })

  it('"98.5" → "985000000"', () => {
    expect(usdcToBaseUnits('98.5')).toBe('985000000')
  })

  it('"0.0000001" → "1"', () => {
    expect(usdcToBaseUnits('0.0000001')).toBe('1')
  })

  it('handles leading/trailing whitespace', () => {
    expect(usdcToBaseUnits('  50  ')).toBe('500000000')
  })

  it('handles 7 fractional digits exactly', () => {
    expect(usdcToBaseUnits('1.1234567')).toBe('11234567')
  })

  it('large integer amount', () => {
    expect(usdcToBaseUnits('1000000')).toBe('10000000000000')
  })

  it('rejects empty string', () => {
    expect(() => usdcToBaseUnits('')).toThrow()
  })

  it('rejects "abc"', () => {
    expect(() => usdcToBaseUnits('abc')).toThrow()
  })

  it('rejects "0"', () => {
    expect(() => usdcToBaseUnits('0')).toThrow(/greater than 0/)
  })

  it('rejects "0.0000000" (zero with 7 zeros)', () => {
    expect(() => usdcToBaseUnits('0.0000000')).toThrow(/greater than 0/)
  })

  it('rejects "1.23456789" (>7 decimal places)', () => {
    expect(() => usdcToBaseUnits('1.23456789')).toThrow()
  })

  it('rejects negative values', () => {
    expect(() => usdcToBaseUnits('-1')).toThrow()
  })

  it('rejects "1.2.3" (multiple dots)', () => {
    expect(() => usdcToBaseUnits('1.2.3')).toThrow()
  })
})
