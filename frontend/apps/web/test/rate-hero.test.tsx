import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TestProviders } from './helpers'
import { queryClient } from '@/app/providers'

vi.mock('@/lib/wallet-kit', () => ({
  getDefaultKit: vi.fn(() => ({})),
}))

const mockUseUsdcBalance = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useUsdcBalance', () => ({
  useUsdcBalance: mockUseUsdcBalance,
}))

const getRateMock = vi.hoisted(() => vi.fn())
vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return { ...actual, getRate: getRateMock }
})

const { RateHero } = await import('@/components/RateHero')

describe('RateHero', () => {
  beforeEach(() => {
    sessionStorage.clear()
    queryClient.clear()
    getRateMock.mockReset()
    mockUseUsdcBalance.mockReset()
    mockUseUsdcBalance.mockReturnValue({
      balance: undefined,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders the live rate once loaded', async () => {
    getRateMock.mockResolvedValue({ asset: 'USDC', fiat: 'IDR', rate: '18123.231', ts: 't' })
    render(
      <TestProviders>
        <RateHero />
      </TestProviders>,
    )
    expect(await screen.findByText('Rp 18.123')).toBeTruthy()
  })

  it('shows "—" while the rate is loading', () => {
    getRateMock.mockReturnValue(new Promise(() => {}))
    render(
      <TestProviders>
        <RateHero />
      </TestProviders>,
    )
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('does not show a delta chip on the first sample (no dummy value)', async () => {
    getRateMock.mockResolvedValue({ asset: 'USDC', fiat: 'IDR', rate: '18000', ts: 't' })
    render(
      <TestProviders>
        <RateHero />
      </TestProviders>,
    )
    await screen.findByText('Rp 18.000')
    expect(screen.queryByText(/^▲/)).toBeNull()
    expect(screen.queryByText(/^▼/)).toBeNull()
  })

  it('shows an up delta chip once a subsequent fetch reports a higher rate', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let call = 0
    getRateMock.mockImplementation(async () => {
      call += 1
      return { asset: 'USDC', fiat: 'IDR', rate: call === 1 ? '18000' : '18100', ts: 't' }
    })

    render(
      <TestProviders>
        <RateHero />
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByText('Rp 18.000')).toBeTruthy())
    expect(screen.queryByText(/^▲/)).toBeNull()

    await vi.advanceTimersByTimeAsync(12000)

    await waitFor(() => expect(screen.getByText('Rp 18.100')).toBeTruthy())
    expect(screen.getByText('▲ 0.56%')).toBeTruthy()
  })

  it('shows a down delta chip once a subsequent fetch reports a lower rate', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    let call = 0
    getRateMock.mockImplementation(async () => {
      call += 1
      return { asset: 'USDC', fiat: 'IDR', rate: call === 1 ? '18000' : '17900', ts: 't' }
    })

    render(
      <TestProviders>
        <RateHero />
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByText('Rp 18.000')).toBeTruthy())
    await vi.advanceTimersByTimeAsync(12000)
    await waitFor(() => expect(screen.getByText('Rp 17.900')).toBeTruthy())
    expect(screen.getByText('▼ 0.56%')).toBeTruthy()
  })

  it('hides the balance row when the balance is undefined (loading / no address)', async () => {
    getRateMock.mockResolvedValue({ asset: 'USDC', fiat: 'IDR', rate: '18000', ts: 't' })
    render(
      <TestProviders>
        <RateHero />
      </TestProviders>,
    )
    await screen.findByText('Rp 18.000')
    expect(screen.queryByText(/in IDR/)).toBeNull()
  })

  it('hides the balance row when the balance is null (no USDC trustline)', async () => {
    mockUseUsdcBalance.mockReturnValue({
      balance: null,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    })
    getRateMock.mockResolvedValue({ asset: 'USDC', fiat: 'IDR', rate: '18000', ts: 't' })
    render(
      <TestProviders>
        <RateHero />
      </TestProviders>,
    )
    await screen.findByText('Rp 18.000')
    expect(screen.queryByText(/in IDR/)).toBeNull()
  })

  it('shows the formatted balance and an IDR approximation when present', async () => {
    mockUseUsdcBalance.mockReturnValue({
      balance: '142.5000000',
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    })
    getRateMock.mockResolvedValue({ asset: 'USDC', fiat: 'IDR', rate: '18000', ts: 't' })
    render(
      <TestProviders>
        <RateHero />
      </TestProviders>,
    )
    expect(await screen.findByText('142.50 USDC')).toBeTruthy()
    expect(screen.getByText(/in IDR/)).toBeTruthy()
  })
})
