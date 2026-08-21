import * as React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
  usePathname: vi.fn(() => '/overview'),
  useRouter: vi.fn(() => ({ back: vi.fn() })),
}))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    authenticate: vi.fn(async () => {
      sessionStorage.setItem('lp_jwt', 'fake-jwt')
    }),
    getMetricsOverview: vi.fn(),
  }
})

const OverviewPage = (await import('@/app/overview/page')).default
const apiClient = await import('@lolipay/api-client')
const { queryClient } = await import('@/app/providers')

const MOCK_METRICS = {
  range: '24h' as const,
  volume_usdc: 1234.56,
  fees_usdc: 12.3,
  avg_settle_secs: 112.5,
  open_disputes: 3,
  orders_count: 40,
  daily_bars: [
    { date: '2026-07-06', volume_usdc: 400 },
    { date: '2026-07-07', volume_usdc: 834.56 },
  ],
  flow_mix: [
    { flow: 'TOP_UP', count: 10, volume_usdc: 400 },
    { flow: 'WITHDRAW', count: 5, volume_usdc: 134.56 },
  ],
  top_lps: [
    { lp_id: 'lp_1', address: 'GRNGABCDEFGH0001', volume_usdc: 500, trades: 12 },
    { lp_id: 'lp_2', address: 'GBUDABCDEFGH0002', volume_usdc: 300, trades: 8 },
  ],
}

const EMPTY_METRICS = {
  range: '24h' as const,
  volume_usdc: 0,
  fees_usdc: 0,
  avg_settle_secs: null,
  open_disputes: 0,
  orders_count: 0,
  daily_bars: [],
  flow_mix: [],
  top_lps: [],
}

describe('Overview page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    queryClient.clear()
  })

  it('renders volume, fees, avg settle, and orders count from getMetricsOverview', async () => {
    vi.mocked(apiClient.getMetricsOverview).mockResolvedValueOnce(MOCK_METRICS)

    render(
      <TestProviders kit={fakeKit}>
        <OverviewPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('overview-volume')).toHaveTextContent('1,234.56')
    })
    expect(screen.getByTestId('overview-fees')).toHaveTextContent('12.30')
    expect(screen.getByTestId('overview-avg-settle')).toHaveTextContent('1m 53s')
    expect(screen.getByTestId('overview-orders-count')).toHaveTextContent('40 orders settled')
    expect(apiClient.getMetricsOverview).toHaveBeenCalledWith(expect.anything(), '24h')
  })

  it('defaults to the 24h range on first load', async () => {
    vi.mocked(apiClient.getMetricsOverview).mockResolvedValueOnce(MOCK_METRICS)

    render(
      <TestProviders kit={fakeKit}>
        <OverviewPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(apiClient.getMetricsOverview).toHaveBeenCalledWith(expect.anything(), '24h')
    })
  })

  it('switching the range toggle refetches with the new range', async () => {
    vi.mocked(apiClient.getMetricsOverview).mockResolvedValue(MOCK_METRICS)

    render(
      <TestProviders kit={fakeKit}>
        <OverviewPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('overview-volume')).toBeTruthy()
    })

    fireEvent.click(screen.getByRole('button', { name: '7d' }))

    await waitFor(() => {
      expect(apiClient.getMetricsOverview).toHaveBeenCalledWith(expect.anything(), '7d')
    })

    fireEvent.click(screen.getByRole('button', { name: '30d' }))

    await waitFor(() => {
      expect(apiClient.getMetricsOverview).toHaveBeenCalledWith(expect.anything(), '30d')
    })
  })

  it('shows open disputes in the danger tone when greater than zero', async () => {
    vi.mocked(apiClient.getMetricsOverview).mockResolvedValueOnce(MOCK_METRICS)

    render(
      <TestProviders kit={fakeKit}>
        <OverviewPage />
      </TestProviders>,
    )

    const disputes = await screen.findByTestId('overview-disputes')
    expect(disputes).toHaveTextContent('3')
    expect(disputes.className).toContain('text-lp-danger')
  })

  it('does NOT use the danger tone when open disputes is zero', async () => {
    vi.mocked(apiClient.getMetricsOverview).mockResolvedValueOnce({
      ...MOCK_METRICS,
      open_disputes: 0,
    })

    render(
      <TestProviders kit={fakeKit}>
        <OverviewPage />
      </TestProviders>,
    )

    const disputes = await screen.findByTestId('overview-disputes')
    expect(disputes).toHaveTextContent('0')
    expect(disputes.className).not.toContain('text-lp-danger')
  })

  it('renders sensible zeros and a dash avg-settle for an empty-data range, without crashing', async () => {
    vi.mocked(apiClient.getMetricsOverview).mockResolvedValueOnce(EMPTY_METRICS)

    render(
      <TestProviders kit={fakeKit}>
        <OverviewPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('overview-volume')).toHaveTextContent('0.00')
    })
    expect(screen.getByTestId('overview-avg-settle')).toHaveTextContent('—')
    expect(screen.getByTestId('overview-disputes')).toHaveTextContent('0')
    expect(screen.getByTestId('overview-daily-bars-empty')).toBeTruthy()
    expect(screen.getByTestId('overview-flow-mix-empty')).toBeTruthy()
    expect(screen.getByTestId('overview-top-lps-empty')).toBeTruthy()
  })

  it('renders the flow mix percentages and top-LP leaderboard', async () => {
    vi.mocked(apiClient.getMetricsOverview).mockResolvedValueOnce(MOCK_METRICS)

    render(
      <TestProviders kit={fakeKit}>
        <OverviewPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('overview-flow-mix')).toBeTruthy()
    })


    expect(screen.getByTestId('overview-top-lps')).toBeTruthy()
    expect(screen.getByTestId('top-lp-lp_1')).toHaveTextContent('12 trades')
    expect(screen.getByTestId('top-lp-lp_1')).toHaveTextContent('500.00')
  })

  it('shows a loading state before the metrics resolve', () => {
    vi.mocked(apiClient.getMetricsOverview).mockReturnValueOnce(new Promise(() => {}))

    render(
      <TestProviders kit={fakeKit}>
        <OverviewPage />
      </TestProviders>,
    )

    expect(screen.getByTestId('overview-loading')).toBeTruthy()
  })

  it('shows an error state when the metrics endpoint fails', async () => {
    vi.mocked(apiClient.getMetricsOverview).mockRejectedValueOnce(new Error('boom'))

    render(
      <TestProviders kit={fakeKit}>
        <OverviewPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('overview-error')).toBeTruthy()
    })
  })
})
