import { describe, expect, it } from 'vitest'
import { xdr } from '@stellar/stellar-sdk'
import { SIGNING_WINDOW_CLOSED, submissionFailure } from '@lolipay/wallet'

describe('the closed-window message is produced from the real XDR the installed SDK decodes, not from a hand-built shape', () => {
  it('decodes txTooLate from a real TransactionResult', () => {
    const errorResult = xdr.TransactionResult.fromXDR('AAAAAAAAAGT////9AAAAAA==', 'base64')
    expect(errorResult.result().switch().name).toBe('txTooLate')
    expect(submissionFailure({ status: 'ERROR', errorResult })).toBe(SIGNING_WINDOW_CLOSED)
  })
})
