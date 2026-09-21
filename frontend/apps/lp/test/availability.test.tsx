import * as React from 'react'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'
import type { PaymentMethod } from '@lolipay/api-client'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
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
    authenticate: vi.fn(),
    getLpMe: vi.fn(),
    setAvailability: vi.fn(),
    heartbeat: vi.fn(),

    getAssignments: vi.fn().mockResolvedValue([]),
    getLpEarnings: vi.fn().mockResolvedValue({ today_trades: 0, today_earned_usdc: 0, today_volume_usdc: 0, week_bars: [], all_time_trades: 0, all_time_earned_usdc: 0 }),
    getLpEligibility: vi.fn(),
    getNotifications: vi.fn().mockResolvedValue({ items: [], unread: 0 }),
  }
})

const DashboardPage = (await import('@/app/page')).default
const apiClient = await import('@lolipay/api-client')

const noStake = {
  staked: '0',
  unbonding: '0',
  unbond_available_at: 0,
  min_stake: '5000000000',
  eligible: false,
}

const eligibleStake = {
  staked: '500000000',
  unbonding: '0',
  unbond_available_at: 0,
  min_stake: '100000000',
  eligible: true,
}

function bankMethod(): PaymentMethod {
  return { id: 'pm-1', lpId: 'lp-1', rail: 'BANK', label: 'BCA', details: '1234567890', currency: 'IDR', active: true }
}

function qrisMethod(): PaymentMethod {
  return { id: 'pm-1', lpId: 'lp-1', rail: 'QRIS', label: 'QRIS', details: 'merchant-1', currency: 'IDR', active: true }
}

function makeLpMe(online = false, matchable = online, paymentMethods: PaymentMethod[] = [bankMethod()]) {
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
    paymentMethods,
  }
}

describe('DashboardPage — Availability', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(false))
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(eligibleStake)
    vi.mocked(apiClient.setAvailability).mockResolvedValue({ ok: true })
    vi.mocked(apiClient.heartbeat).mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the availability toggle after me loads', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('availability-toggle')).toBeTruthy()
    })
  })

  it('toggle starts in offline state (aria-pressed=false) when me.online=false', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    const toggle = screen.getByTestId('availability-toggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
  })

  it('toggle starts in online state (aria-pressed=true) when me.online=true', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    const toggle = screen.getByTestId('availability-toggle')
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
  })

  it('calls setAvailability(true) when toggling from offline to online', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    fireEvent.click(screen.getByTestId('availability-toggle'))

    await waitFor(() => {
      expect(apiClient.setAvailability).toHaveBeenCalledWith(
        expect.anything(),
        true,
      )
    })
  })

  it('calls setAvailability(false) when toggling from online to offline', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    fireEvent.click(screen.getByTestId('availability-toggle'))

    await waitFor(() => {
      expect(apiClient.setAvailability).toHaveBeenCalledWith(
        expect.anything(),
        false,
      )
    })
  })

  it('shows "Online — accepting orders" text after toggling on', async () => {
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(eligibleStake)
    vi.mocked(apiClient.setAvailability).mockImplementation(async (_client, next) => {
      vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(next, next))
      return { ok: true }
    })
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    expect(screen.getByTestId('availability-state').textContent).toBe('Offline')

    fireEvent.click(screen.getByTestId('availability-toggle'))

    await waitFor(() => {
      expect(screen.getByTestId('availability-state').textContent).toBe('Online — accepting orders')
    })
  })

  it('keeps the switch pressed when the refetch after toggling fails, because the ack is what was written', async () => {
    vi.mocked(apiClient.setAvailability).mockImplementation(async () => {
      vi.mocked(apiClient.getLpMe).mockRejectedValue(new Error('transient blip'))
      return { ok: true }
    })
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )
    await waitFor(() => screen.getByTestId('availability-toggle'))
    fireEvent.click(screen.getByTestId('availability-toggle'))
    await waitFor(() => {
      expect(screen.getByTestId('availability-toggle').getAttribute('aria-pressed')).toBe('true')
    })
    expect(queryClient.getQueryData(['lpMe'])).toMatchObject({ online: true })
  })

  it('does not claim orders are being accepted while the refetch that would prove it has failed', async () => {
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(eligibleStake)
    vi.mocked(apiClient.setAvailability).mockImplementation(async () => {
      vi.mocked(apiClient.getLpMe).mockRejectedValue(new Error('transient blip'))
      return { ok: true }
    })
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )
    await waitFor(() => screen.getByTestId('availability-toggle'))
    fireEvent.click(screen.getByTestId('availability-toggle'))
    await waitFor(() => {
      expect(screen.getByTestId('availability-toggle').getAttribute('aria-pressed')).toBe('true')
    })
    expect(screen.getByTestId('availability-state').textContent).toBe('Online — not receiving orders')
  })

  it('tells a provider the platform cannot match that orders are not reaching them, even with the switch on', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true, false))
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(eligibleStake)
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    expect(screen.getByTestId('availability-state').textContent).toBe('Online — not receiving orders')
    expect(screen.queryByText(/accepting orders/i)).toBeNull()
  })

  it('says orders are being accepted only when the platform says the provider is matchable', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true, true))
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(eligibleStake)
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    expect(screen.getByTestId('availability-state').textContent).toBe('Online — accepting orders')
  })

  it('does not say "accepting orders" for a provider whose only active method is QRIS, because every first-party order door creates a BANK-rail order', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true, true, [qrisMethod()]))
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(eligibleStake)
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    expect(screen.getByTestId('availability-state').textContent).toBe('Online — not receiving orders')
    expect(screen.queryByText(/accepting orders/i)).toBeNull()
    expect(screen.queryByTestId('online-ring')).toBeNull()
  })

  it('says Offline when the switch is off, whatever the platform thinks of the provider', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(false, true))
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(eligibleStake)
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    expect(screen.getByTestId('availability-state').textContent).toBe('Offline')
    expect(screen.queryByTestId('online-ring')).toBeNull()
  })

  it('withholds the live ring from a provider no order can reach, so the light agrees with the sentence', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true, false))
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(eligibleStake)
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    expect(screen.queryByTestId('online-ring')).toBeNull()
  })

  it('shows the live ring to a provider orders can reach', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true, true))
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(eligibleStake)
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    expect(screen.getByTestId('online-ring')).toBeTruthy()
  })

  it('stops claiming orders are being accepted once the check-in has been failing longer than the grace, whatever the cached row still says', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true, true))
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(eligibleStake)
    queryClient.setQueryData(['lpBeatFailingSince'], Date.now() - 2_700_000)
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await screen.findByText('Eligible')
    expect(screen.getByTestId('availability-state').textContent).toBe('Online — not receiving orders')
    expect(screen.queryByTestId('online-ring')).toBeNull()
  })

  it('does not tell a provider with no eligible stake that orders are being accepted, because the matcher will pass them over', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true, true))
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(noStake)
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await screen.findByText('Not eligible')
    expect(screen.getByTestId('availability-state').textContent).toBe('Online — not receiving orders')
    expect(screen.queryByTestId('online-ring')).toBeNull()
  })

  it('keeps showing Eligible on the stake pill while the stake is unbonding, since unbonding alone no longer costs a match', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true, true))
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue({ ...eligibleStake, unbonding: '1' })
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await screen.findByText('Eligible')
    expect(screen.queryByText('Not matchable')).toBeNull()
    expect(screen.getByTestId('availability-state').textContent).toBe('Online — accepting orders')
  })

  it('shows the eligibility link', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))

    const link = screen.getByRole('link', { name: 'View stake & eligibility' })
    expect(link).toBeTruthy()
    expect(link.getAttribute('href')).toBe('/stake')
  })
})

describe('the dashboard keeps its own picture of the provider fresh', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))
    vi.mocked(apiClient.getLpEligibility).mockResolvedValue(noStake)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reads the provider row four times as often as the stake, because the stake read is six uncached RPC calls', async () => {
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe(true))
    vi.useFakeTimers()
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(apiClient.getLpMe).toHaveBeenCalledTimes(1)
    expect(apiClient.getLpEligibility).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    expect(apiClient.getLpMe).toHaveBeenCalledTimes(2)
    expect(apiClient.getLpEligibility).toHaveBeenCalledTimes(1)
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'))
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(apiClient.getLpEligibility).toHaveBeenCalledTimes(2)
  })

  it('carries the prerequisite card, so a provider sees what is missing on the page they land on', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )
    expect(await screen.findByTestId('prereq-card')).toBeTruthy()
  })

  it('re-reads the stake on a slow timer, so a provider slashed elsewhere does not keep a green pill forever', async () => {
    vi.useFakeTimers()
    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(apiClient.getLpEligibility).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000)
    })
    expect(apiClient.getLpEligibility).toHaveBeenCalledTimes(2)
  })
})
