import { describe, expect, it } from 'vitest'
import { SIGNING_WINDOW_CLOSED, submissionFailure } from '../submission'

describe('a refused submission tells the person what happened, not just that it happened', () => {
  it('names the closed signing window when the network answers txTooLate, in the accessor form and the property form', () => {
    expect(submissionFailure({ status: 'ERROR', errorResult: { result: () => ({ switch: () => ({ name: 'txTooLate' }) }) } })).toBe(SIGNING_WINDOW_CLOSED)
    expect(submissionFailure({ status: 'ERROR', errorResult: { result: { type: 'txTooLate' } } })).toBe(SIGNING_WINDOW_CLOSED)
  })

  it('carries the network code for any other refusal, and stays readable when there is none or the body is garbage', () => {
    expect(submissionFailure({ status: 'ERROR', errorResult: { result: () => ({ switch: () => ({ name: 'txBadSeq' }) }) } })).toBe('Submission failed (ERROR, txBadSeq)')
    expect(submissionFailure({ status: 'TRY_AGAIN_LATER' })).toBe('Submission failed (TRY_AGAIN_LATER)')
    expect(submissionFailure({ status: 'ERROR', errorResult: 'garbage' })).toBe('Submission failed (ERROR)')
  })
})
