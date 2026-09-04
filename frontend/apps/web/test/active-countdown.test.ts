import { describe, it, expect } from 'vitest'
import { activeCountdown } from '@/lib/steps'

const base = {
  flow: 'WITHDRAW',
  pay_deadline: 1_800,
  confirm_deadline: 3_600,
  expires_at: '2096-10-02T06:56:40.000Z',
}

describe('the countdown a user sees never counts to an instant the escrow does not enforce', () => {
  it('shows no countdown at FIAT_PAID on a withdrawal, because confirm_and_release has no deadline and a provider could size one by marking paid late', () => {
    expect(activeCountdown({ ...base, status: 'FIAT_PAID' })).toBeNull()
  })

  it('still counts the lock window at MATCHED, which expires_at now measures exactly', () => {
    const cd = activeCountdown({ ...base, status: 'MATCHED' })
    expect(cd?.label).toBe('Lock within')
    expect(cd?.deadline).toBe(Math.floor(new Date(base.expires_at).getTime() / 1000))
  })

  it('still tells a withdrawing user how long the provider has to pay at FUNDED, which the refund route really opens after', () => {
    expect(activeCountdown({ ...base, status: 'FUNDED' })).toEqual({ deadline: 3_600, label: 'Merchant pays within' })
  })
})
