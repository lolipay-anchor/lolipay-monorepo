import { describe, it, expect } from 'vitest'
import {
  paymentDetailsError,
  PAYMENT_DETAILS_TOO_SHORT_MESSAGE,
  PAYMENT_DETAILS_BAD_CHARS_MESSAGE,
} from '@/lib/payment-destination'

describe('paymentDetailsError', () => {
  it('refuses a three-character destination', () => {
    expect(paymentDetailsError('BCA')).toBe(PAYMENT_DETAILS_TOO_SHORT_MESSAGE)
  })

  it('refuses five word characters as too short', () => {
    expect(paymentDetailsError('BCA 12')).toBe(PAYMENT_DETAILS_TOO_SHORT_MESSAGE)
  })

  it('accepts exactly six word characters', () => {
    expect(paymentDetailsError('BCA 123')).toBeNull()
  })

  it('does not count punctuation toward the floor', () => {
    expect(paymentDetailsError('------')).toBe(PAYMENT_DETAILS_TOO_SHORT_MESSAGE)
  })

  it('trims before judging length', () => {
    expect(paymentDetailsError('   BCA 123   ')).toBeNull()
  })

  it.each([
    ['U+001B ESCAPE', 0x001b],
    ['U+200B ZERO WIDTH SPACE', 0x200b],
    ['U+200E LEFT-TO-RIGHT MARK', 0x200e],
    ['U+202E RIGHT-TO-LEFT OVERRIDE', 0x202e],
    ['U+00AD SOFT HYPHEN', 0x00ad],
    ['U+2028 LINE SEPARATOR', 0x2028],
    ['U+2029 PARAGRAPH SEPARATOR', 0x2029],
  ])('refuses a destination carrying %s', (_label, codePoint) => {
    const raw = `BCA 123${String.fromCodePoint(codePoint)}456`
    expect(paymentDetailsError(raw)).toBe(PAYMENT_DETAILS_BAD_CHARS_MESSAGE)
  })

  it('refuses a destination carrying a lone surrogate', () => {
    const raw = `BCA 123${String.fromCodePoint(0xd800)}456`
    expect(paymentDetailsError(raw)).toBe(PAYMENT_DETAILS_BAD_CHARS_MESSAGE)
  })

  it('does not flag a legitimate destination as containing bad characters', () => {
    expect(paymentDetailsError('BCA 1234567890 a/n Rio Prayogo')).toBeNull()
  })
})
