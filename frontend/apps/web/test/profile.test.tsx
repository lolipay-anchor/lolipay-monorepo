import * as React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'

vi.mock('@/lib/wallet-kit', () => ({
  getDefaultKit: vi.fn(() => ({})),
}))

const replace = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ back: vi.fn(), push: vi.fn(), replace })),
  usePathname: vi.fn(() => '/profile'),
}))

const mockUseUsdcBalance = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useUsdcBalance', () => ({
  useUsdcBalance: mockUseUsdcBalance,
}))

const toastMock = vi.hoisted(() => vi.fn())
vi.mock('@/components/Toast', () => ({
  useToast: () => toastMock,
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}))

const mockGetMyProfile = vi.hoisted(() => vi.fn())
vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return { ...actual, getMyProfile: mockGetMyProfile }
})

const { default: ProfilePage } = await import('@/app/profile/page')

const MOCK_PROFILE = {
  tier: 'SILVER' as const,
  completed_trades: 7,
  disputes_lost: 1,
  completion_rate: 0.875,
  daily_limit_usdc: 300,
  daily_used_usdc: 40,
  daily_remaining_usdc: 260,
}

const ADDR = 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X'

function authed() {
  sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
  sessionStorage.setItem('lp_addr', ADDR)
}

function kitWithDisconnectSpy() {
  return { ...fakeKit, disconnect: vi.fn(async () => {}) }
}

describe('ProfilePage', () => {
  beforeEach(() => {
    sessionStorage.clear()
    queryClient.clear()
    replace.mockClear()
    toastMock.mockClear()
    mockUseUsdcBalance.mockReset()
    mockUseUsdcBalance.mockReturnValue({
      balance: undefined,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    })
    mockGetMyProfile.mockReset()
    mockGetMyProfile.mockResolvedValue(MOCK_PROFILE)
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    })
  })

  it('shows "—" when the balance is not yet known', async () => {
    authed()
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    expect(await screen.findByText(/—/)).toBeTruthy()
  })

  it('shows "—" when there is no USDC trustline (balance null)', async () => {
    authed()
    mockUseUsdcBalance.mockReturnValue({
      balance: null,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    })
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    expect(await screen.findByText(/—/)).toBeTruthy()
  })

  it('formats a known balance to 2dp', async () => {
    authed()
    mockUseUsdcBalance.mockReturnValue({
      balance: '142.5000000',
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    })
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    expect(await screen.findByText(/142\.50/)).toBeTruthy()
  })

  it('renders the truncated address chip', async () => {
    authed()
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    expect(await screen.findByText(/GDCP…SC6X · Stellar/)).toBeTruthy()
  })

  it('copies the FULL address to the clipboard and fires a toast when the chip is clicked', async () => {
    authed()
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    const chip = await screen.findByRole('button', { name: /copy/i })
    fireEvent.click(chip)

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(ADDR)
    })
    expect(toastMock).toHaveBeenCalled()
    const [message] = toastMock.mock.calls[0]
    expect(message).toMatch(/address copied/i)
  })

  it('links "Become a liquidity provider" to lp.lolipay.app with an Earn badge', async () => {
    authed()
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    const link = (await screen.findByText('Become a liquidity provider')).closest('a')
    expect(link?.getAttribute('href')).toBe('https://lp.lolipay.app')
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(screen.getByText('Earn')).toBeTruthy()
  })

  it('does NOT fabricate rating, recovery-phrase, or payout-account entries', async () => {
    authed()
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    await screen.findByText('Become a liquidity provider')
    expect(screen.queryByText(/recovery phrase/i)).toBeNull()
    expect(screen.queryByText(/payout accounts/i)).toBeNull()
    expect(screen.queryByText(/trusted trader/i)).toBeNull()
  })

  it('renders the non-custodial footer', async () => {
    authed()
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    expect(
      await screen.findByText('non-custodial · keys never leave your device'),
    ).toBeTruthy()
  })

  it('disconnect calls wallet.disconnect, clears the auth session, and redirects home', async () => {
    authed()
    const kit = kitWithDisconnectSpy()
    render(
      <TestProviders kit={kit as any}>
        <ProfilePage />
      </TestProviders>,
    )
    const btn = await screen.findByText('Disconnect wallet')
    fireEvent.click(btn)

    expect(kit.disconnect).toHaveBeenCalled()
    expect(sessionStorage.getItem('lp_jwt')).toBeNull()
    expect(sessionStorage.getItem('lp_addr')).toBeNull()
    expect(replace).toHaveBeenCalledWith('/')
  })
})

describe('ProfilePage — tier card', () => {
  beforeEach(() => {
    sessionStorage.clear()
    queryClient.clear()
    replace.mockClear()
    toastMock.mockClear()
    mockUseUsdcBalance.mockReset()
    mockUseUsdcBalance.mockReturnValue({
      balance: undefined,
      isLoading: false,
      isError: false,
      error: null,
      refetch: vi.fn(),
    })
    mockGetMyProfile.mockReset()
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    })
  })

  it('shows a loading skeleton before the profile resolves', async () => {
    authed()
    mockGetMyProfile.mockReturnValue(new Promise(() => {}))
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    expect(await screen.findByTestId('tier-card-skeleton')).toBeTruthy()
    expect(screen.queryByTestId('tier-card')).toBeNull()
  })

  it('renders the tier badge, progress to next tier, daily limit, disputes lost, and completion %', async () => {
    authed()
    mockGetMyProfile.mockResolvedValue(MOCK_PROFILE)
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    const card = await screen.findByTestId('tier-card')
    expect(card).toHaveTextContent('Silver')
    expect(card).toHaveTextContent('7 / 20 trades to Trusted')
    expect(card).toHaveTextContent('260.00')
    expect(card).toHaveTextContent('300.00')
    expect(card).toHaveTextContent('1')
    expect(card).toHaveTextContent('88%')
  })

  it('shows "Highest tier reached" for GOLD instead of a progress bar', async () => {
    authed()
    mockGetMyProfile.mockResolvedValue({
      ...MOCK_PROFILE,
      tier: 'GOLD',
      completed_trades: 60,
    })
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    const card = await screen.findByTestId('tier-card')
    expect(card).toHaveTextContent('Gold')
    expect(card).toHaveTextContent('Highest tier reached')
    expect(card).not.toHaveTextContent('trades to')
  })

  it('clamps the progress numerator for a demoted user — never shows more completed trades than the next tier threshold', async () => {
    authed()

    mockGetMyProfile.mockResolvedValue({ ...MOCK_PROFILE, tier: 'SILVER', completed_trades: 25 })
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    const card = await screen.findByTestId('tier-card')
    expect(card).toHaveTextContent('20 / 20 trades to Trusted')
    expect(card).not.toHaveTextContent('25 / 20')
  })

  it('shows an em-dash for completion rate when there is no concluded history yet', async () => {
    authed()
    mockGetMyProfile.mockResolvedValue({ ...MOCK_PROFILE, completion_rate: null })
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    const card = await screen.findByTestId('tier-card')
    expect(card).toHaveTextContent('—')
  })

  it('hides the tier card entirely on a profile fetch error (never fabricates a tier)', async () => {
    authed()
    mockGetMyProfile.mockRejectedValue(new Error('network down'))
    render(
      <TestProviders>
        <ProfilePage />
      </TestProviders>,
    )
    await screen.findByText('Become a liquidity provider')
    await waitFor(() => {
      expect(screen.queryByTestId('tier-card-skeleton')).toBeNull()
    })
    expect(screen.queryByTestId('tier-card')).toBeNull()
  })
})
