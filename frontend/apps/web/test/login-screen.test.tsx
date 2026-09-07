import * as React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'

vi.mock('@/lib/wallet-kit', () => ({
  getDefaultKit: vi.fn(() => ({})),
}))

const MOCK_MARKETS = [
  { code: 'IDR', country: 'Indonesia', currency_symbol: 'Rp', locale: 'id-ID', rail_name: 'QRIS', enabled: true },
  { code: 'PHP', country: 'Philippines', currency_symbol: '₱', locale: 'en-PH', rail_name: 'InstaPay', enabled: false },
  { code: 'VND', country: 'Vietnam', currency_symbol: '₫', locale: 'vi-VN', rail_name: 'VietQR', enabled: false },
  { code: 'INR', country: 'India', currency_symbol: '₹', locale: 'en-IN', rail_name: 'UPI', enabled: false },
  { code: 'THB', country: 'Thailand', currency_symbol: '฿', locale: 'th-TH', rail_name: 'PromptPay', enabled: false },
  { code: 'BRL', country: 'Brazil', currency_symbol: 'R$', locale: 'pt-BR', rail_name: 'PIX', enabled: false },
]

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    authenticate: vi.fn(async (_client: unknown, _addr: string) => {
      sessionStorage.setItem('lp_jwt', 'fake-jwt')
    }),
    getRate: vi.fn(
      async () => ({ asset: 'USDC', fiat: 'IDR', rate: '18123.231', ts: 't' }),
    ),
    getMarkets: vi.fn(async () => MOCK_MARKETS),
  }
})

const { LoginScreen } = await import('@/components/LoginScreen')
const apiClient = await import('@lolipay/api-client')

describe('LoginScreen', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.clearAllMocks()
    fakeKit.getAddress.mockResolvedValue({ address: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X' })
    fakeKit.signMessage.mockResolvedValue({ signedMessage: btoa('fake-signature') })

    queryClient.clear()
  })

  it('renders the exact tagline', () => {
    render(
      <TestProviders kit={fakeKit}>
        <LoginScreen />
      </TestProviders>,
    )
    expect(
      screen.getByText(
        'Buy & sell USDC for rupiah, peer-to-peer — non-custodial.',
      ),
    ).toBeTruthy()
  })

  it('promises no bill payment, and says settlement is by bank transfer, because that is what the product does', () => {
    render(
      <TestProviders kit={fakeKit}>
        <LoginScreen />
      </TestProviders>,
    )
    expect(screen.queryByText(/bill/i)).toBeNull()
    expect(screen.getByText(/settles via bank transfer/i)).toBeTruthy()
  })

  it('renders 6 country chips from getMarkets, only IDR enabled — the other 5 disabled with "Coming soon"', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <LoginScreen />
      </TestProviders>,
    )

    expect(apiClient.getMarkets).toHaveBeenCalled()

    const codes = ['IDR', 'PHP', 'VND', 'INR', 'THB', 'BRL']
    const chips = await Promise.all(
      codes.map(async (code) => (await screen.findByText(code)).closest('button')),
    )
    chips.forEach((chip) => expect(chip).toBeTruthy())

    const disabled = chips.filter((chip) => chip?.hasAttribute('disabled'))
    expect(disabled).toHaveLength(5)

    const idrChip = screen.getByText('IDR').closest('button')
    expect(idrChip?.hasAttribute('disabled')).toBe(false)

    expect(screen.getAllByText('Coming soon')).toHaveLength(5)
  })

  it('falls back to the static country list when getMarkets rejects (pre-login must never be blank)', async () => {
    vi.mocked(apiClient.getMarkets).mockRejectedValueOnce(new Error('network error'))

    render(
      <TestProviders kit={fakeKit}>
        <LoginScreen />
      </TestProviders>,
    )

    const codes = ['IDR', 'PHP', 'VND', 'INR', 'THB', 'BRL']
    for (const code of codes) {
      expect(screen.getByText(code)).toBeTruthy()
    }

    await waitFor(() => {
      expect(apiClient.getMarkets).toHaveBeenCalled()
    })

    const idrChip = screen.getByText('IDR').closest('button')
    expect(idrChip?.hasAttribute('disabled')).toBe(false)
    expect(screen.getAllByText('Coming soon')).toHaveLength(5)
  })

  it('shows — before the rate resolves, then the live rate', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <LoginScreen />
      </TestProviders>,
    )

    expect(screen.getByText('—')).toBeTruthy()

    expect(await screen.findByText('Rp 18.123')).toBeTruthy()
  })

  it('Connect wallet CTA invokes the existing connect flow (wallet connect + SEP-53 login)', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <LoginScreen />
      </TestProviders>,
    )

    fireEvent.click(screen.getByText('Connect wallet'))

    await waitFor(() => {
      expect(sessionStorage.getItem('lp_jwt')).toBe('fake-jwt')
    })
    expect(fakeKit.openModal).toHaveBeenCalled()
  })

  it('while connect is in-flight, busy hint with wallet approval text renders and CTA is disabled', async () => {
    fakeKit.openModal.mockImplementation(() => new Promise(() => {}))

    render(
      <TestProviders kit={fakeKit}>
        <LoginScreen />
      </TestProviders>,
    )

    const ctaButton = screen.getByRole('button', { name: /Connect wallet/i })
    fireEvent.click(ctaButton)

    expect(ctaButton).toBeDisabled()

    const hint = screen.getByRole('status')
    expect(hint).toHaveTextContent('Approve the request in your wallet')
    expect(hint).toHaveTextContent('wallet')
  })

  it('when wallet.connect rejects, error message renders with role="alert"', async () => {
    const errorMsg = 'User rejected connection'
    fakeKit.openModal.mockRejectedValue(new Error(errorMsg))

    render(
      <TestProviders kit={fakeKit}>
        <LoginScreen />
      </TestProviders>,
    )

    fireEvent.click(screen.getByText('Connect wallet'))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(errorMsg)
  })

  it('shows the expiry sentence only while there is nothing else to say, and forgets it once a login succeeds', async () => {
    fakeKit.openModal.mockImplementation(async ({ onWalletSelected }: { onWalletSelected: (w: { id: string }) => void }) => {
      onWalletSelected({ id: 'freighter' })
    })
    sessionStorage.setItem('lp_expired', '1')
    render(
      <TestProviders kit={fakeKit}>
        <LoginScreen />
      </TestProviders>,
    )
    expect(screen.getByTestId('session-expired').textContent).toBe('Your session expired. Reconnect your wallet to continue.')
    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }))
    await waitFor(() => {
      expect(sessionStorage.getItem('lp_jwt')).toBe('fake-jwt')
    })
    expect(sessionStorage.getItem('lp_expired')).toBeNull()
  })

  it('drops the expiry sentence the moment the screen has an error of its own, so one message shows at a time', async () => {
    fakeKit.openModal.mockRejectedValueOnce(new Error('User rejected connection'))
    sessionStorage.setItem('lp_expired', '1')
    render(
      <TestProviders kit={fakeKit}>
        <LoginScreen />
      </TestProviders>,
    )
    expect(screen.getByTestId('session-expired')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }))
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('User rejected connection')
    expect(screen.queryByTestId('session-expired')).toBeNull()
  })
})
