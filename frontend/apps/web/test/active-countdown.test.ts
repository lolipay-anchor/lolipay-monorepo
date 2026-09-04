import { describe, it, expect } from 'vitest'
import { activeCountdown } from '@/lib/steps'

const base = {
  flow: 'WITHDRAW',
  pay_deadline: 1_800,
  confirm_deadline: 3_600,
  expires_at: '2096-10-02T06:56:40.000Z',
}

describe('the countdown a user sees never counts to an instant nothing enforces against the user', () => {
  it('shows no countdown at FIAT_PAID on a withdrawal, because confirm_and_release has no deadline and a provider could size one by marking paid late', () => {
    expect(activeCountdown({ ...base, status: 'FIAT_PAID' })).toBeNull()
  })

  it('still counts the lock window at MATCHED, which expires_at now measures exactly', () => {
    const cd = activeCountdown({ ...base, status: 'MATCHED' })
    expect(cd?.label).toBe('Lock within')
    expect(cd?.deadline).toBe(Math.floor(new Date(base.expires_at).getTime() / 1000))
  })

  it('still counts the merchant release window on a deposit at FIAT_PAID, a countdown about the counterparty while the user keeps the dispute door', () => {
    expect(activeCountdown({ ...base, flow: 'TOP_UP', status: 'FIAT_PAID' })).toEqual({ deadline: 3_600, label: 'Merchant releases within' })
  })

  it('still tells a withdrawing user how long the provider has to pay at FUNDED, which the refund route really opens after', () => {
    expect(activeCountdown({ ...base, status: 'FUNDED' })).toEqual({ deadline: 3_600, label: 'Merchant pays within' })
  })
})
