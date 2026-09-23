import * as React from 'react'
import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'
import { PrereqCard } from '@/components/PrereqCard'
import type { Eligibility, LpMe, PaymentMethod } from '@lolipay/api-client'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))

const T0 = Date.parse('2026-09-07T16:00:00Z')

function method(active: boolean): PaymentMethod {
  return { id: 'pm-1', lpId: 'lp-1', rail: 'BANK', label: 'BCA', details: '1234567890', currency: 'IDR', active }
}

function provider(extra: Partial<LpMe> = {}): LpMe {
  return {
    id: 'lp-1',
    stellarAddress: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X',
    status: 'APPROVED',
    contact: 'lp@example.com',
    liquidityProof: 'https://example.com/proof',
    approvalNote: null,
    online: true,
    matchable: true,
    lastHeartbeatAt: new Date(T0 - 5_000).toISOString(),
    createdAt: new Date(T0 - 86_400_000).toISOString(),
    approvedAt: null,
    paymentMethods: [method(true)],
    reachable: true,
    ...extra,
  }
}

const ready: Eligibility = { staked: '500000000', unbonding: '0', unbond_available_at: 0, min_stake: '100000000', eligible: true }

function mount(me: LpMe, eligibility: Eligibility | undefined) {
  return render(
    <TestProviders kit={fakeKit}>
      <PrereqCard me={me} eligibility={eligibility} />
    </TestProviders>,
  )
}

const tick = (id: string) => screen.getByTestId(`prereq-${id}`).getAttribute('data-ok')

describe('the dashboard shows the three prerequisites with honest ticks', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks all three for a staked, banked, online provider whose beat is seconds old, and keeps the card', () => {
    mount(provider(), ready)
    expect(tick('stake')).toBe('true')
    expect(tick('payment-method')).toBe('true')
    expect(tick('heartbeat')).toBe('true')
    expect(screen.getByText('last seen 5 s ago')).toBeTruthy()
    expect(screen.getByTestId('prereq-card')).toBeTruthy()
  })

  it('keeps the stake row ticked while USDC is unbonding, as long as the contract still calls the provider eligible', () => {
    mount(provider(), { ...ready, unbonding: '1' })
    expect(tick('stake')).toBe('true')
  })

  it('shows a dash for the stake row while eligibility is unknown, and still renders the other two rows', () => {
    mount(provider(), undefined)
    expect(tick('stake')).toBe('unknown')
    expect(screen.getByText('—')).toBeTruthy()
    expect(tick('payment-method')).toBe('true')
    expect(tick('heartbeat')).toBe('true')
  })

  it('wants an active payment method, not merely a stored one', () => {
    mount(provider({ paymentMethods: [method(false)] }), ready)
    expect(tick('payment-method')).toBe('false')
  })

  it('says "not yet" when no heartbeat was ever received, whether or not the provider is online', () => {
    mount(provider({ lastHeartbeatAt: null, online: true, matchable: false }), ready)
    expect(screen.getByText('not yet')).toBeTruthy()
    expect(tick('heartbeat')).toBe('false')
  })

  it('does not count a recent beat for a provider who is offline', () => {
    mount(provider({ online: false, matchable: false }), ready)
    expect(tick('heartbeat')).toBe('false')
    expect(screen.getByText('last seen 5 s ago')).toBeTruthy()
  })

  it('keeps its own clock, so the printed age counts up while the cached row is unchanged', async () => {
    mount(provider(), ready)
    expect(screen.getByText('last seen 5 s ago')).toBeTruthy()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(150_000)
    })
    expect(screen.getByText('last seen 155 s ago')).toBeTruthy()
  })

  it('carries no freshness window of its own: a beat the platform still counts keeps the tick though it is older than the keeper\'s own grace', () => {
    mount(provider({ lastHeartbeatAt: new Date(T0 - 90_000).toISOString(), matchable: true }), ready)
    expect(screen.getByText('last seen 90 s ago')).toBeTruthy()
    expect(tick('heartbeat')).toBe('true')
  })

  it('keeps the tick while the check-in is failing, as long as the platform still counts this provider matchable — the heartbeat is an observation, not a gate (ADR 0053)', () => {
    queryClient.setQueryData(['lpBeatFailingSince'], T0 - 2_700_000)
    mount(provider({ matchable: true }), ready)
    expect(screen.getByText('check-in failing for 45 min')).toBeTruthy()
    expect(tick('heartbeat')).toBe('true')
  })

  it('still counts the keeper\'s own beat one and a half intervals after it landed', async () => {
    queryClient.setQueryData(['lpLastBeat'], T0)
    mount(provider({ lastHeartbeatAt: null, matchable: false }), ready)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(45_000)
    })
    expect(tick('heartbeat')).toBe('true')
  })

  it('stops counting the keeper\'s own beat once two of its intervals have passed without another', async () => {
    queryClient.setQueryData(['lpLastBeat'], T0)
    mount(provider({ lastHeartbeatAt: null, matchable: false }), ready)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000)
    })
    expect(tick('heartbeat')).toBe('false')
  })

  it('keeps the heartbeat row honest for a provider the platform cannot match for want of a payment method', () => {
    queryClient.setQueryData(['lpLastBeat'], T0 - 5_000)
    mount(provider({ matchable: false, paymentMethods: [method(false)] }), ready)
    expect(tick('payment-method')).toBe('false')
    expect(tick('heartbeat')).toBe('true')
  })

  it('names a check-in that has been refused for longer than one beat interval, so a four-day silence is not silent', () => {
    queryClient.setQueryData(['lpLastBeat'], T0 - 240_000)
    queryClient.setQueryData(['lpBeatFailingSince'], T0 - 240_000)
    mount(provider({ matchable: false }), ready)
    expect(screen.getByText('check-in failing for 4 min')).toBeTruthy()
  })

  it('stays quiet about a refusal younger than the grace that costs the tick, so a transient blip does not scream', () => {
    queryClient.setQueryData(['lpLastBeat'], T0 - 5_000)
    queryClient.setQueryData(['lpBeatFailingSince'], T0 - 59_000)
    mount(provider({ matchable: false }), ready)
    expect(screen.getByText('last seen 5 s ago')).toBeTruthy()
    expect(screen.queryByText(/check-in failing/)).toBeNull()
  })

  it('speaks at the first moment it loses the tick, and never announces a failure of no minutes', () => {
    queryClient.setQueryData(['lpLastBeat'], T0 - 60_000)
    queryClient.setQueryData(['lpBeatFailingSince'], T0 - 60_000)
    mount(provider({ matchable: false }), ready)
    expect(screen.getByText('check-in failing for 1 min')).toBeTruthy()
  })

  it('counts a refusal of a few hours in hours', () => {
    queryClient.setQueryData(['lpBeatFailingSince'], T0 - 10_800_000)
    mount(provider({ matchable: false }), ready)
    expect(screen.getByText('check-in failing for 3 h')).toBeTruthy()
  })

  it('counts a refusal of several days in days', () => {
    queryClient.setQueryData(['lpBeatFailingSince'], T0 - 345_600_000)
    mount(provider({ matchable: false }), ready)
    expect(screen.getByText('check-in failing for 4 d')).toBeTruthy()
  })

  it('trusts the keeper\'s own successful beat over a stale server value, so the first seconds after going online are not shown as stale', () => {
    queryClient.setQueryData(['lpLastBeat'], T0 - 3_000)
    mount(provider({ lastHeartbeatAt: new Date(T0 - 300_000).toISOString(), matchable: false }), ready)
    expect(screen.getByText('last seen 3 s ago')).toBeTruthy()
    expect(tick('heartbeat')).toBe('true')
  })

  it('leaves the payment row To do when the only active method is not a bank account, because orders arrive over bank transfer', () => {
    mount(provider({ paymentMethods: [{ ...method(true), rail: 'QRIS' }] }), ready)
    expect(tick('payment-method')).toBe('false')
  })

  it('does not let a malformed server heartbeat poison the beat the keeper itself recorded', () => {
    queryClient.setQueryData(['lpLastBeat'], T0 - 3_000)
    mount(provider({ lastHeartbeatAt: 'not a date', matchable: false }), ready)
    expect(tick('heartbeat')).toBe('true')
    expect(screen.getByText('last seen 3 s ago')).toBeTruthy()
  })

  it('floors the printed age to whole seconds rather than rounding it up', () => {
    mount(provider({ lastHeartbeatAt: new Date(T0 - 119_600).toISOString() }), ready)
    expect(screen.getByText('last seen 119 s ago')).toBeTruthy()
  })
})
