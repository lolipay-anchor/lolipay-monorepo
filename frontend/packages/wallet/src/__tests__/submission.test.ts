import { describe, expect, it } from 'vitest'
import { SUBMISSION_WINDOW_CLOSED, submissionFailure } from '../submission'

describe('a refused submission tells the person what happened, not just that it happened', () => {
  it('names the expired transaction when the network answers txTooLate, in the accessor form and the property form', () => {
    expect(submissionFailure({ status: 'ERROR', errorResult: { result: () => ({ switch: () => ({ name: 'txTooLate' }) }) } })).toBe(SUBMISSION_WINDOW_CLOSED)
    expect(submissionFailure({ status: 'ERROR', errorResult: { result: { type: 'txTooLate' } } })).toBe(SUBMISSION_WINDOW_CLOSED)
  })

  it('never promises that the order will expire, because the same message is shown on the release and dispute legs where nothing expires and the money is already committed', () => {
    expect(SUBMISSION_WINDOW_CLOSED).not.toMatch(/expire on its own|order will|on its own/i)
    expect(SUBMISSION_WINDOW_CLOSED).toMatch(/try again/i)
  })

  it('carries the network code for any other refusal, and stays readable when there is none, the body is garbage, or an accessor throws', () => {
    expect(submissionFailure({ status: 'ERROR', errorResult: { result: () => ({ switch: () => ({ name: 'txBadSeq' }) }) } })).toBe('Submission failed (ERROR, txBadSeq)')
    expect(submissionFailure({ status: 'TRY_AGAIN_LATER' })).toBe('Submission failed (TRY_AGAIN_LATER)')
    expect(submissionFailure({ status: 'ERROR', errorResult: 'garbage' })).toBe('Submission failed (ERROR)')
    expect(submissionFailure({ status: 'ERROR', errorResult: { result: () => { throw new Error('boom') } } })).toBe('Submission failed (ERROR)')
  })
})
