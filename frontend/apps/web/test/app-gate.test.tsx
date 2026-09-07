import * as React from 'react'
import { render, screen, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'
import { SESSION_EXPIRED_EVENT } from '@lolipay/api-client'

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
    getRate: vi.fn(
      async () => ({ asset: 'USDC', fiat: 'IDR', rate: '18123.231', ts: 't' }),
    ),
  }
})

const { AppGate } = await import('@/components/AppGate')

describe('AppGate', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.clearAllMocks()

    queryClient.clear()
  })

  it('renders LoginScreen (with Connect Wallet) and hides children when no token', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="gated-content">GATED</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Connect wallet')).toBeTruthy()
    })

    expect(
      screen.getByText(
        'Buy & sell USDC for rupiah, peer-to-peer — non-custodial.',
      ),
    ).toBeTruthy()

    expect(screen.queryByTestId('gated-content')).toBeNull()

    expect(screen.queryByText('Home')).toBeNull()
    expect(screen.queryByText('Orders')).toBeNull()
  })

  it('renders children and NavShell when JWT is in sessionStorage', async () => {
    sessionStorage.setItem('lp_jwt', 'test-token')

    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="gated-content">GATED</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('gated-content')).toBeTruthy()
    })

    expect(screen.getByText('Home')).toBeTruthy()
    expect(screen.getByText('Orders')).toBeTruthy()

    expect(screen.queryByText('Connect wallet')).toBeNull()
  })

  it('returns to the login screen, with the sentence, when the api client reports the session expired', async () => {
    sessionStorage.setItem('lp_jwt', 'live-jwt')
    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="shell">SHELL</div>
        </AppGate>
      </TestProviders>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('shell')).toBeTruthy()
    })
    await act(async () => {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
    })
    await waitFor(() => {
      expect(screen.getByTestId('session-expired').textContent).toBe('Your session expired. Reconnect your wallet to continue.')
    })
    expect(screen.queryByTestId('shell')).toBeNull()
    expect(sessionStorage.getItem('lp_expired')).toBe('1')
  })
})
