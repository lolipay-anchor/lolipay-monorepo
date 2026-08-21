import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'

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
    getLpEligibility: vi.fn().mockResolvedValue({
      staked: '0',
      unbonding: '0',
      unbond_available_at: 0,
      min_stake: '5000000000',
      eligible: false,
    }),
    getNotifications: vi.fn().mockResolvedValue({ items: [], unread: 0 }),
    getLpEarnings: vi.fn(),
  }
})

const DashboardPage = (await import('@/app/page')).default
const apiClient = await import('@lolipay/api-client')

function makeLpMe() {
  return {
    id: 'lp-1',
    stellarAddress: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X',
    status: 'APPROVED' as const,
    contact: 'test@example.com',
    liquidityProof: 'https://proof.example.com',
    approvalNote: null,
    online: false,
    lastHeartbeatAt: null,
    createdAt: new Date().toISOString(),
    approvedAt: null,
    paymentMethods: [],
  }
}

function makeWeekBars(overrides?: Partial<{ volume: number[]; earned: number[] }>) {
  const volumes = overrides?.volume ?? [0, 0, 0, 0, 0, 0, 0]
  const earned = overrides?.earned ?? [0, 0, 0, 0, 0, 0, 0]
  const days = ['2026-07-02', '2026-07-03', '2026-07-04', '2026-07-05', '2026-07-06', '2026-07-07', '2026-07-08']
  return days.map((date, i) => ({ date, volume_usdc: volumes[i], earned_usdc: earned[i] }))
}

const REAL_EARNINGS = {
  today_trades: 12,
  today_earned_usdc: 3.84,
  today_volume_usdc: 640.5,
  week_bars: makeWeekBars({
    volume: [10, 20, 15, 40, 25, 60, 640.5],
    earned: [0.1, 0.2, 0.15, 0.4, 0.25, 0.6, 3.84],
  }),
  all_time_trades: 210,
  all_time_earned_usdc: 128.42,
}

const ZERO_EARNINGS = {
  today_trades: 0,
  today_earned_usdc: 0,
  today_volume_usdc: 0,
  week_bars: makeWeekBars(),
  all_time_trades: 0,
  all_time_earned_usdc: 0,
}

describe('DashboardPage — Earnings', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    vi.mocked(apiClient.getLpMe).mockResolvedValue(makeLpMe())
    vi.mocked(apiClient.setAvailability).mockResolvedValue({ ok: true })
    vi.mocked(apiClient.heartbeat).mockResolvedValue({ ok: true })
  })

  it('renders real today_trades / today_earned_usdc / today_volume_usdc from getLpEarnings', async () => {
    vi.mocked(apiClient.getLpEarnings).mockResolvedValue(REAL_EARNINGS)

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('earnings-orders-today')).toHaveTextContent('12')
    })
    expect(screen.getByTestId('earnings-usdc-earned')).toHaveTextContent('+3.84')
    expect(screen.getByTestId('earnings-volume-today')).toHaveTextContent('640.50')
    expect(apiClient.getLpEarnings).toHaveBeenCalledWith(expect.anything())
  })

  it('renders a sparkline polyline scaled from week_bars', async () => {
    vi.mocked(apiClient.getLpEarnings).mockResolvedValue(REAL_EARNINGS)

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('earnings-sparkline')).toBeTruthy()
    })
    const sparkline = screen.getByTestId('earnings-sparkline')
    const polyline = sparkline.querySelector('polyline')
    expect(polyline).toBeTruthy()
    const points = polyline!.getAttribute('points')!.trim().split(' ')

    expect(points).toHaveLength(7)
  })

  it('renders a flat baseline sparkline (not a fake trend) when week_bars are all zero', async () => {
    vi.mocked(apiClient.getLpEarnings).mockResolvedValue(ZERO_EARNINGS)

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('earnings-sparkline')).toBeTruthy()
    })
    const polyline = screen.getByTestId('earnings-sparkline').querySelector('polyline')!
    const ys = polyline
      .getAttribute('points')!
      .trim()
      .split(' ')
      .map((p) => parseFloat(p.split(',')[1]))

    expect(new Set(ys).size).toBe(1)
  })

  it('shows a loading skeleton before earnings resolve', async () => {
    vi.mocked(apiClient.getLpEarnings).mockReturnValue(new Promise(() => {}))

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('earnings-loading')).toBeTruthy()
    })
    expect(screen.queryByTestId('earnings-tiles')).toBeNull()
  })

  it('hides the earnings tiles (no fake zeros) when the endpoint errors', async () => {
    vi.mocked(apiClient.getLpEarnings).mockRejectedValue(new Error('boom'))

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('availability-toggle'))
    await waitFor(() => {
      expect(apiClient.getLpEarnings).toHaveBeenCalled()
    })

    expect(screen.queryByTestId('earnings-tiles')).toBeNull()
    expect(screen.queryByTestId('earnings-loading')).toBeNull()
    expect(screen.queryByTestId('earnings-orders-today')).toBeNull()
  })

  it('shows real 0s (not hidden) for a brand-new LP with a genuinely zeroed shape', async () => {
    vi.mocked(apiClient.getLpEarnings).mockResolvedValue(ZERO_EARNINGS)

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('earnings-tiles')).toBeTruthy()
    })
    expect(screen.getByTestId('earnings-orders-today')).toHaveTextContent('0')
    expect(screen.getByTestId('earnings-usdc-earned')).toHaveTextContent('+0.00')
    expect(screen.getByTestId('earnings-volume-today')).toHaveTextContent('0.00')
  })

  it('renders the all-time totals footnote from the same earnings fetch', async () => {
    vi.mocked(apiClient.getLpEarnings).mockResolvedValue(REAL_EARNINGS)

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('earnings-all-time')).toHaveTextContent('210 trades')
    })
    expect(screen.getByTestId('earnings-all-time')).toHaveTextContent('128.42 USDC earned')
  })

  it('does not fetch earnings before `me` resolves (gated on authed LP)', async () => {
    vi.mocked(apiClient.getLpMe).mockReturnValue(new Promise(() => {}))
    vi.mocked(apiClient.getLpEarnings).mockResolvedValue(REAL_EARNINGS)

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    expect(apiClient.getLpEarnings).not.toHaveBeenCalled()
  })

  it('keeps the online toggle, assignments tile, and stake CTA unchanged alongside earnings', async () => {
    vi.mocked(apiClient.getLpEarnings).mockResolvedValue(REAL_EARNINGS)

    render(
      <TestProviders kit={fakeKit}>
        <DashboardPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('earnings-tiles')).toBeTruthy()
    })
    expect(screen.getByTestId('availability-toggle')).toBeTruthy()
    expect(screen.getByText('Active assignments')).toBeTruthy()
    expect(screen.getByRole('link', { name: /View stake/i })).toBeTruthy()
  })
})
