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

function makeLpMe(online = false, matchable = online) {
  return {
    id: 'lp-1',
    stellarAddress: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X',
    status: 'APPROVED' as const,
    contact: 'test@example.com',
    liquidityProof: 'https://proof.example.com',
    approvalNote: null,
    online,
    matchable,
    lastHeartbeatAt: null,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    paymentMethods: [],
    reachable: true,
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
    const setQueryData = vi.spyOn(queryClient, 'setQueryData')
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    const recorded = queryClient.getQueryData<number>(['lpLastBeat'])
    expect(recorded).toBeGreaterThanOrEqual(t0)
    expect(recorded).toBeLessThanOrEqual(t0 + 100)
    expect(queryClient.getQueryData<{ lastHeartbeatAt: string | null }>(['lpMe'])?.lastHeartbeatAt).toBeNull()
    expect(setQueryData).not.toHaveBeenCalledWith(['lpMe'], expect.anything())
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

  it('records the moment its beat started being refused, so a refusal nobody can see becomes visible', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-07T16:00:00Z')
    vi.setSystemTime(t0)
    vi.mocked(apiClient.heartbeat).mockRejectedValue(new Error('403'))
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(queryClient.getQueryData(['lpBeatFailingSince'])).toBe(t0)
  })

  it('keeps the first refusal\'s time across later refusals, so the age of the failure is the age of the failure', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-07T16:00:00Z')
    vi.setSystemTime(t0)
    vi.mocked(apiClient.heartbeat).mockRejectedValue(new Error('403'))
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(4)
    expect(queryClient.getQueryData(['lpBeatFailingSince'])).toBe(t0)
  })

  it('clears the refusal the moment a beat lands again, so a transient blip does not become permanent', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-07T16:00:00Z')
    vi.setSystemTime(t0)
    vi.mocked(apiClient.heartbeat).mockRejectedValueOnce(new Error('blip')).mockResolvedValue({ ok: true })
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(queryClient.getQueryData(['lpBeatFailingSince'])).toBe(t0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(queryClient.getQueryData(['lpBeatFailingSince'])).toBeNull()
  })

  it('forgets a failing check-in when the provider goes offline, so a switch they turned off does not keep reporting a failure', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-07T16:00:00Z')
    vi.setSystemTime(t0)
    vi.mocked(apiClient.heartbeat).mockRejectedValue(new Error('403'))
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(queryClient.getQueryData(['lpBeatFailingSince'])).toBe(t0)

    await act(async () => {
      queryClient.setQueryData(['lpMe'], makeLpMe(false))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(queryClient.getQueryData(['lpBeatFailingSince'])).toBeNull()
  })

  it('does not record a refusal that lands after the provider has already gone offline', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-07T16:00:00Z')
    vi.setSystemTime(t0)
    let rejectBeat: (e: Error) => void = () => {}
    vi.mocked(apiClient.heartbeat).mockImplementation(
      () => new Promise((_resolve, reject) => { rejectBeat = reject }),
    )
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(queryClient.getQueryData(['lpBeatFailingSince'])).toBeUndefined()

    await act(async () => {
      queryClient.setQueryData(['lpMe'], makeLpMe(false))
      await vi.advanceTimersByTimeAsync(0)
    })
    await act(async () => {
      rejectBeat(new Error('offline'))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(queryClient.getQueryData(['lpBeatFailingSince'])).toBeNull()
  })

  it('re-reads the provider row after its first beat lands, so a row written before that beat does not stand for thirty seconds', async () => {
    vi.useFakeTimers()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true, false))
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(1)
    expect(apiClient.getLpMe).toHaveBeenCalledTimes(2)
  })

  it('re-reads it once and not on every beat, so a provider who stays unmatchable is not polled by the keeper as well', async () => {
    vi.useFakeTimers()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true, false))
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(4)
    expect(apiClient.getLpMe).toHaveBeenCalledTimes(2)
  })

  it('leaves a row that already says the provider is matchable alone, so the keeper adds no traffic of its own', async () => {
    vi.useFakeTimers()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true, true))
    mount()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(4)
    expect(apiClient.getLpMe).toHaveBeenCalledTimes(1)
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
