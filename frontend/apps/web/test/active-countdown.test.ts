import { describe, it, expect, vi, afterEach } from 'vitest'
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
    expect(cd).toEqual({ deadline: 3_999_999_340, label: 'Lock within' })
  })

  it('falls back to expires_at for an order the coordinator serialised before sign_by existed', () => {
    const cd = activeCountdown({ ...base, status: 'MATCHED' })
    expect(cd).toEqual({
      deadline: Math.floor(new Date(base.expires_at).getTime() / 1000),
      label: 'Lock within',
    })
  })

  it('shows no countdown at FIAT_PAID on a deposit either, because confirm_and_release has no deadline on that flow any more than the withdrawal side does', () => {
    expect(activeCountdown({ ...base, flow: 'TOP_UP', status: 'FIAT_PAID' })).toBeNull()
  })

  it('shows the expired state at FUNDED once confirm_deadline has passed, instead of freezing on a stale countdown', () => {
    expect(activeCountdown({ ...base, status: 'FUNDED' })).toEqual({
      label: "Merchant's time is up",
      expired: true,
    })
  })

  it('still tells a withdrawing user how long the provider has to pay at FUNDED, before confirm_deadline has passed', () => {
    const now = Math.floor(Date.now() / 1000)
    const cd = activeCountdown({ ...base, status: 'FUNDED', confirm_deadline: now + 3_600, refund_opens_at: now + 3_600 })
    expect(cd).toEqual({ deadline: now + 3_601, label: 'Merchant pays within' })
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
    const refundOpensAt = now + 900
    const cd = activeCountdown({
      ...base,
      flow: 'TOP_UP',
      status: 'FUNDED',
      pay_deadline: now - 500,
      refund_opens_at: refundOpensAt,
    })
    expect(cd).toEqual({ deadline: refundOpensAt + 1, label: 'Can still be confirmed for' })
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

describe('the refund-opens countdown survives through the boundary second, agreeing with the chain (ts <= opens_at refuses)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('at exactly refund_opens_at: still counts down — the chain has not opened the refund yet, and the shown clock targets the same instant the row unmounts at', () => {
    vi.useFakeTimers()
    const now = Math.floor(Date.now() / 1000)
    vi.setSystemTime(now * 1000)
    const cd = activeCountdown({
      ...base,
      flow: 'TOP_UP',
      status: 'FUNDED',
      pay_deadline: now - 500,
      refund_opens_at: now,
    })
    expect(cd).toEqual({ deadline: now + 1, label: 'Can still be confirmed for' })
  })

  it('at refund_opens_at + 1 second: the row disappears, matching the instant the chain actually opens the refund', () => {
    vi.useFakeTimers()
    const now = Math.floor(Date.now() / 1000)
    vi.setSystemTime((now + 1) * 1000)
    const cd = activeCountdown({
      ...base,
      flow: 'TOP_UP',
      status: 'FUNDED',
      pay_deadline: now - 500,
      refund_opens_at: now,
    })
    expect(cd).toBeNull()
  })
})

describe('the merchant-pays countdown on a withdrawal survives through the same boundary second, agreeing with the chain (ts <= opens_at refuses)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('at exactly refund_opens_at (== confirm_deadline on a WITHDRAW order): still counts down', () => {
    vi.useFakeTimers()
    const now = Math.floor(Date.now() / 1000)
    vi.setSystemTime(now * 1000)
    const cd = activeCountdown({
      ...base,
      status: 'FUNDED',
      confirm_deadline: now,
      refund_opens_at: now,
    })
    expect(cd).toEqual({ deadline: now + 1, label: 'Merchant pays within' })
  })

  it('at refund_opens_at + 1 second: switches to the expired row, matching the instant the chain actually opens the refund', () => {
    vi.useFakeTimers()
    const now = Math.floor(Date.now() / 1000)
    vi.setSystemTime((now + 1) * 1000)
    const cd = activeCountdown({
      ...base,
      status: 'FUNDED',
      confirm_deadline: now,
      refund_opens_at: now,
    })
    expect(cd).toEqual({ label: "Merchant's time is up", expired: true })
  })
})
