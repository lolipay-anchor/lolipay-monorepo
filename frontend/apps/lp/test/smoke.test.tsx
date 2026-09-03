import * as React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'

vi.mock('@/lib/wallet-kit', () => ({
  getDefaultKit: vi.fn(() => ({})),
}))

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string
    children: React.ReactNode
    [key: string]: unknown
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/'),
  useRouter: vi.fn(() => ({ back: vi.fn() })),
}))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    authenticate: vi.fn(async (_client: unknown, _addr: string) => {
      sessionStorage.setItem('lp_jwt', 'fake-jwt')
    }),

    getLpMe: vi.fn(),
    applyLp: vi.fn(),
    heartbeat: vi.fn().mockResolvedValue({ ok: true }),
  }
})

const { AppGate } = await import('@/components/AppGate')
const { queryClient } = await import('@/app/providers')
const apiClient = await import('@lolipay/api-client')

function makeLpMe(status: 'PENDING' | 'APPROVED' | 'SUSPENDED' | 'REVOKED', extra = {}) {
  return {
    id: 'lp-1',
    stellarAddress: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X',
    status,
    contact: 'test@example.com',
    liquidityProof: 'https://example.com/proof',
    approvalNote: null,
    online: false,
    lastHeartbeatAt: null,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    paymentMethods: [],
    ...extra,
  }
}

describe('AppGate (LP)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.clearAllMocks()
    vi.mocked(apiClient.getLpMe).mockReset()

    queryClient.clear()
  })

  it('shows the LP LoginScreen (Connect Wallet) when no token', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="lp-shell">LP SHELL</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Connect Wallet')).toBeTruthy()
    })

    expect(screen.getByText('lolipay LP')).toBeTruthy()
    expect(screen.getByText('Provide liquidity. Earn on every trade.')).toBeTruthy()

    expect(screen.queryByTestId('lp-shell')).toBeNull()
    expect(screen.queryByText('Dashboard')).toBeNull()
    expect(screen.queryByText('Assign')).toBeNull()
  })

  it('shows the Apply form when token exists and getLpMe returns null', async () => {
    sessionStorage.setItem('lp_jwt', 'some-jwt')

    vi.mocked(apiClient.getLpMe).mockResolvedValueOnce(null)

    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="lp-shell">LP SHELL</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Submit Application')).toBeTruthy()
    })

    expect(screen.getByTestId('apply-contact')).toBeTruthy()
    expect(screen.getByTestId('apply-liquidity-proof')).toBeTruthy()

    expect(screen.queryByTestId('lp-shell')).toBeNull()
    expect(screen.queryByText('Dashboard')).toBeNull()
  })

  it('shows the pending review screen when getLpMe returns status PENDING', async () => {
    sessionStorage.setItem('lp_jwt', 'pending-jwt')

    vi.mocked(apiClient.getLpMe).mockResolvedValueOnce(makeLpMe('PENDING'))

    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="lp-shell">LP SHELL</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/Application under review/i)).toBeTruthy()
    })

    expect(screen.getByText(/test@example.com/)).toBeTruthy()
    expect(screen.getByText(/Refresh/i)).toBeTruthy()

    expect(screen.queryByTestId('lp-shell')).toBeNull()
    expect(screen.queryByText('Dashboard')).toBeNull()
  })

  it('shows notice screen when getLpMe returns status SUSPENDED', async () => {
    sessionStorage.setItem('lp_jwt', 'suspended-jwt')

    vi.mocked(apiClient.getLpMe).mockResolvedValueOnce(
      makeLpMe('SUSPENDED', { approvalNote: 'Insufficient stake' }),
    )

    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="lp-shell">LP SHELL</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/suspended/i)).toBeTruthy()
    })

    expect(screen.queryByText(/Insufficient stake/)).toBeNull()
    expect(screen.getByText(/Contact support/i)).toBeTruthy()
    expect(screen.getByText('Disconnect')).toBeTruthy()

    expect(screen.queryByTestId('lp-shell')).toBeNull()
    expect(screen.queryByText('Dashboard')).toBeNull()
  })

  it('shows a Reconnect recovery screen (NOT blank) when getLpMe 401s (dead JWT)', async () => {
    sessionStorage.setItem('lp_jwt', 'dead-jwt')
    vi.mocked(apiClient.getLpMe).mockRejectedValue(new apiClient.ApiError(401, 'Unauthorized'))

    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="lp-shell">LP SHELL</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByText(/session expired/i)).toBeTruthy())
    expect(screen.getByText('Reconnect')).toBeTruthy()

    expect(screen.queryByTestId('lp-shell')).toBeNull()
  })

  it('shows a Retry recovery screen (NOT blank) when getLpMe fails with a server error', async () => {
    sessionStorage.setItem('lp_jwt', 'valid-jwt')
    vi.mocked(apiClient.getLpMe).mockRejectedValue(new apiClient.ApiError(503, 'Service Unavailable'))

    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="lp-shell">LP SHELL</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByText(/Couldn't load your LP profile/i)).toBeTruthy())
    expect(screen.getByText('Retry')).toBeTruthy()
    expect(screen.queryByTestId('lp-shell')).toBeNull()
  })

  it('keeps the dashboard (NOT the recovery screen) when a refetch errors but a profile is cached', async () => {
    sessionStorage.setItem('lp_jwt', 'approved-jwt')
    queryClient.setQueryData(['lpMe'], makeLpMe('APPROVED'))
    vi.mocked(apiClient.getLpMe).mockRejectedValue(new apiClient.ApiError(503, 'transient blip'))

    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="lp-shell">LP SHELL</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByTestId('lp-shell')).toBeTruthy())

    expect(screen.queryByText(/Couldn't load your LP profile/i)).toBeNull()
    expect(screen.queryByText(/session expired/i)).toBeNull()
  })

  it('shows the LP dashboard shell and nav when getLpMe returns status APPROVED', async () => {
    sessionStorage.setItem('lp_jwt', 'approved-jwt')

    vi.mocked(apiClient.getLpMe).mockResolvedValueOnce(makeLpMe('APPROVED'))

    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="lp-shell">LP SHELL</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('lp-shell')).toBeTruthy()
    })

    expect(screen.getByText('Dashboard')).toBeTruthy()
    expect(screen.getByText('Rails')).toBeTruthy()
    expect(screen.getByText('Assign')).toBeTruthy()
    expect(screen.getByText('Stake')).toBeTruthy()

    expect(screen.queryByText('Connect Wallet')).toBeNull()
    expect(screen.queryByText(/Application under review/i)).toBeNull()
  })

  it('keeps an approved online provider heartbeating from inside the gate, on whatever page', async () => {
    sessionStorage.setItem('lp_jwt', 'approved-jwt')
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe('APPROVED', { online: true }))
    vi.useFakeTimers()
    try {
      render(
        <TestProviders kit={fakeKit}>
          <AppGate>
            <div data-testid="lp-shell">LP SHELL</div>
          </AppGate>
        </TestProviders>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(apiClient.heartbeat).toHaveBeenCalledTimes(1)
      expect(apiClient.getLpMe).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      expect(apiClient.heartbeat).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('never heartbeats for a provider the gate does not admit', async () => {
    sessionStorage.setItem('lp_jwt', 'suspended-jwt')
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe('SUSPENDED', { online: true }))
    vi.useFakeTimers()
    try {
      render(
        <TestProviders kit={fakeKit}>
          <AppGate>
            <div data-testid="lp-shell">LP SHELL</div>
          </AppGate>
        </TestProviders>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(apiClient.heartbeat).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
})
