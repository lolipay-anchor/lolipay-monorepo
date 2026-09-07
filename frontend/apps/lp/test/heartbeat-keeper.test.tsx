import * as React from 'react'
import { render, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))
vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getLpMe: vi.fn(),
    heartbeat: vi.fn(),
  }
})

const { HeartbeatKeeper } = await import('@/components/HeartbeatKeeper')
const apiClient = await import('@lolipay/api-client')

function makeLpMe(online = false) {
  return {
    id: 'lp-1',
    stellarAddress: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X',
    status: 'APPROVED' as const,
    contact: 'test@example.com',
    liquidityProof: 'https://proof.example.com',
    approvalNote: null,
    online,
    lastHeartbeatAt: null,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    paymentMethods: [],
  }
}

function mount() {
  return render(
    <TestProviders kit={fakeKit}>
      <HeartbeatKeeper />
    </TestProviders>,
  )
}

describe('HeartbeatKeeper — the provider stays matchable on every page, not only the dashboard', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.mocked(apiClient.heartbeat).mockReset().mockResolvedValue({ ok: true })
    vi.mocked(apiClient.getLpMe).mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('beats the moment it learns the provider is online, then every 30 seconds', async () => {
    vi.useFakeTimers()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(2)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(3)
  })

  it('records the time of its own successful beat under its own key and leaves the provider row alone', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-07T16:00:00Z')
    vi.setSystemTime(t0)
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    const recorded = queryClient.getQueryData<number>(['lpLastBeat'])
    expect(recorded).toBeGreaterThanOrEqual(t0)
    expect(recorded).toBeLessThanOrEqual(t0 + 100)
    expect(queryClient.getQueryData<{ lastHeartbeatAt: string | null }>(['lpMe'])?.lastHeartbeatAt).toBeNull()
  })

  it('records nothing when the beat is refused', async () => {
    vi.useFakeTimers()
    vi.mocked(apiClient.heartbeat).mockRejectedValue(new Error('offline'))
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(1)
    expect(queryClient.getQueryData(['lpLastBeat'])).toBeUndefined()
  })

  it('does NOT call heartbeat when offline, having read the profile', async () => {
    vi.useFakeTimers()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(false))
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000)
    })
    expect(apiClient.getLpMe).toHaveBeenCalled()
    expect(apiClient.heartbeat).not.toHaveBeenCalled()
  })

  it('stops when unmounted, so a closed tab does not keep a provider falsely online', async () => {
    vi.useFakeTimers()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))
    const view = mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(2)

    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(2)
  })
})
