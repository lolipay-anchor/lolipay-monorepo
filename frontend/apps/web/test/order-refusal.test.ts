import { describe, expect, it } from 'vitest'
import { explainOrderRefusal, IDENTITY_REQUIRED } from '@/lib/order-refusal'

describe('what a refused order tells the person', () => {
  it('turns the anchor identity refusal into a sentence that says what to do', () => {
    expect(explainOrderRefusal('identity verification is required before a trade can be opened')).toBe(IDENTITY_REQUIRED)
  })

  it('passes every other refusal through untouched, because the anchor already wrote it for a person', () => {
    expect(explainOrderRefusal('Add a USDC trustline to your wallet before ordering — you need it to receive USDC.')).toBe(
      'Add a USDC trustline to your wallet before ordering — you need it to receive USDC.',
    )
    expect(explainOrderRefusal('')).toBe('The order could not be opened. Please try again.')
  })
})
