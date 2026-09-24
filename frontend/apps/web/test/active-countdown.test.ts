import { describe, it, expect } from 'vitest'
import { activeCountdown } from '@/lib/steps'

const base = {
  flow: 'WITHDRAW' as const,
  pay_deadline: 1_800,
  confirm_deadline: 3_600,
  refund_opens_at: 3_600,
  expires_at: '2096-10-02T06:56:40.000Z',
}

describe('the countdown a user sees never counts to an instant nothing enforces against the user', () => {
  it('shows no countdown at FIAT_PAID on a withdrawal, because confirm_and_release has no deadline and a provider could size one by marking paid late', () => {
    expect(activeCountdown({ ...base, status: 'FIAT_PAID' })).toBeNull()
  })

  it('counts the lock window at MATCHED to sign_by, the instant the coordinator stops accepting the signature, a minute before expires_at', () => {
    const cd = activeCountdown({ ...base, status: 'MATCHED', sign_by: 3_999_999_340 })
    expect(cd?.label).toBe('Lock within')
    expect(cd?.deadline).toBe(3_999_999_340)
  })

  it('falls back to expires_at for an order the coordinator serialised before sign_by existed', () => {
    const cd = activeCountdown({ ...base, status: 'MATCHED' })
    expect(cd?.deadline).toBe(Math.floor(new Date(base.expires_at).getTime() / 1000))
  })

  it('still counts the merchant release window on a deposit at FIAT_PAID, a countdown about the counterparty while the user keeps the dispute door', () => {
    expect(activeCountdown({ ...base, flow: 'TOP_UP', status: 'FIAT_PAID' })).toEqual({ deadline: 3_600, label: 'Merchant releases within' })
  })

  it('still tells a withdrawing user how long the provider has to pay at FUNDED, which the refund route really opens after', () => {
    expect(activeCountdown({ ...base, status: 'FUNDED' })).toEqual({ deadline: 3_600, label: 'Merchant pays within' })
  })

  it('counts to the pay deadline at FUNDED on a top-up, before that deadline has passed', () => {
    const now = Math.floor(Date.now() / 1000)
    const cd = activeCountdown({
      ...base,
      flow: 'TOP_UP',
      status: 'FUNDED',
      pay_deadline: now + 500,
      refund_opens_at: now + 900,
    })
    expect(cd).toEqual({ deadline: now + 500, label: 'Pay within' })
  })

  it('switches to counting the refund-opens instant once the pay deadline has passed but the refund has not opened yet', () => {
    const now = Math.floor(Date.now() / 1000)
    const cd = activeCountdown({
      ...base,
      flow: 'TOP_UP',
      status: 'FUNDED',
      pay_deadline: now - 500,
      refund_opens_at: now + 900,
    })
    expect(cd).toEqual({ deadline: now + 900, label: 'Can still be confirmed for' })
  })

  it('shows no countdown at all once the refund window has opened, because a zeroed clock cannot be told apart from a stalled one', () => {
    const now = Math.floor(Date.now() / 1000)
    const cd = activeCountdown({
      ...base,
      flow: 'TOP_UP',
      status: 'FUNDED',
      pay_deadline: now - 900,
      refund_opens_at: now - 500,
    })
    expect(cd).toBeNull()
  })
})
