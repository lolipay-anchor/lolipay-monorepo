import { describe, it, expect } from 'vitest'
import {
  paymentDetailsError,
  PAYMENT_DETAILS_MIN_NON_WS_MESSAGE,
  PAYMENT_DETAILS_BAD_CHARS_MESSAGE,
} from '@/lib/payment-destination'

describe('paymentDetailsError', () => {
  it('refuses a three-character destination', () => {
    expect(paymentDetailsError('BCA')).toBe(PAYMENT_DETAILS_MIN_NON_WS_MESSAGE)
  })

  it('refuses five non-whitespace characters as too short', () => {
    expect(paymentDetailsError('BCA12')).toBe(PAYMENT_DETAILS_MIN_NON_WS_MESSAGE)
  })

  it('accepts exactly six non-whitespace characters', () => {
    expect(paymentDetailsError('BCA 999')).toBeNull()
  })

  it('counts punctuation toward the floor, matching the server regex', () => {
    expect(paymentDetailsError('------')).toBeNull()
  })

  it.each([
    ['U+200B ZERO WIDTH SPACE', 0x200b],
    ['U+200E LEFT-TO-RIGHT MARK', 0x200e],
    ['U+202E RIGHT-TO-LEFT OVERRIDE', 0x202e],
    ['U+00AD SOFT HYPHEN', 0x00ad],
  ])('refuses a destination carrying %s', (_label, codePoint) => {
    const raw = `BCA 123${String.fromCodePoint(codePoint)}456`
    expect(paymentDetailsError(raw)).toBe(PAYMENT_DETAILS_BAD_CHARS_MESSAGE)
  })

  it('does not flag a legitimate destination as containing bad characters', () => {
    expect(paymentDetailsError('BCA 1234567890 a/n Rio Prayogo')).toBeNull()
  })
})
