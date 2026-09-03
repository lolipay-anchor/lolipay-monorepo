import * as React from 'react'
import { render, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/assignments'),
  useRouter: vi.fn(() => ({ back: vi.fn(), push: vi.fn() })),
}))
vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    authenticate: vi.fn(),
    getLpMe: vi.fn(),
    heartbeat: vi.fn(),
    getNotifications: vi.fn().mockResolvedValue({ items: [], unread: 0 }),
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

describe('HeartbeatKeeper — the provider stays matchable on every page, not only the dashboard', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.mocked(apiClient.heartbeat).mockReset().mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls heartbeat at 30-second intervals while online', async () => {
    vi.useFakeTimers()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))

    render(
      <TestProviders kit={fakeKit}>
        <HeartbeatKeeper />
      </TestProviders>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(2)
  })

  it('does NOT call heartbeat when offline', async () => {
    vi.useFakeTimers()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(false))

    render(
      <TestProviders kit={fakeKit}>
        <HeartbeatKeeper />
      </TestProviders>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000)
    })
    expect(apiClient.heartbeat).not.toHaveBeenCalled()
  })

  it('stops when unmounted, so a closed tab does not keep a provider falsely online', async () => {
    vi.useFakeTimers()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))

    const view = render(
      <TestProviders kit={fakeKit}>
        <HeartbeatKeeper />
      </TestProviders>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_100)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(1)

    view.unmount()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(apiClient.heartbeat).toHaveBeenCalledTimes(1)
  })
})
