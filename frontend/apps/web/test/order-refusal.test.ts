import { describe, expect, it } from 'vitest'
import { explainOrderRefusal, IDENTITY_REQUIRED, QUOTE_FALLBACK } from '@/lib/order-refusal'

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

  it('never shows a person a transport failure verbatim, because "POST /orders → 502" is not a sentence the anchor wrote', () => {
    expect(explainOrderRefusal('POST /orders → 502')).toBe('The order could not be opened. Please try again.')
    expect(explainOrderRefusal('Failed to fetch')).toBe('The order could not be opened. Please try again.')
    expect(explainOrderRefusal('NetworkError when attempting to fetch resource.')).toBe('The order could not be opened. Please try again.')
  })
})

describe('the refusals the anchor sends most often are said in plain words', () => {
  it.each([
    ['platform is paused', 'Trading is paused right now. Please try again later.'],
    ['no eligible LP available', 'No provider can take this order right now. Try again in a few minutes.'],
    ['quote amount is outside current limits', 'This amount is outside the current limits. Try a different amount.'],
    ['daily limit exceeded', 'This order would go past your 24-hour limit. Try a smaller amount, or try again later.'],
    ['quote already used', 'That price expired. Get a new quote and try again.'],
    ['quote expired', 'That price expired. Get a new quote and try again.'],
  ])('"%s" becomes "%s"', (backend, sentence) => {
    expect(explainOrderRefusal(backend)).toBe(sentence)
  })

  it('leaves a sentence it has no words for as the anchor wrote it, and never mistakes a neighbouring sentence for one it knows', () => {
    expect(explainOrderRefusal('the escrow contract is paused on-chain')).toBe('the escrow contract is paused on-chain')
    expect(explainOrderRefusal('Your session expired. Reconnect your wallet to continue.')).toBe('Your session expired. Reconnect your wallet to continue.')
    expect(explainOrderRefusal('quote does not belong to you')).toBe('quote does not belong to you')
    expect(explainOrderRefusal('the amount exceeds the per-order limit set by the provider')).toBe('the amount exceeds the per-order limit set by the provider')
  })
})

describe('the fallback belongs to the door that failed', () => {
  it('folds a body this app could not read into the fallback, by the shape the client gives it rather than by the parser\'s prose', () => {
    expect(explainOrderRefusal('POST /orders → 200')).toBe('The order could not be opened. Please try again.')
    expect(explainOrderRefusal('POST /quotes → 200', QUOTE_FALLBACK)).toBe('Could not get a price right now. Please try again.')
  })

  it('uses the quote door\'s own sentence for a transport failure while pricing, because no order exists yet', () => {
    expect(explainOrderRefusal('Failed to fetch', QUOTE_FALLBACK)).toBe('Could not get a price right now. Please try again.')
  })

  it('never lets the fallback replace a refusal the anchor actually wrote', () => {
    expect(explainOrderRefusal('daily limit exceeded', QUOTE_FALLBACK)).toBe(
      'This order would go past your 24-hour limit. Try a smaller amount, or try again later.',
    )
  })
})
