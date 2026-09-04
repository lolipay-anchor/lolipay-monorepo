import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
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
    authenticate: vi.fn(async () => {
      sessionStorage.setItem('lp_jwt', 'fake-jwt')
    }),

    getAdminConfig: vi.fn(),
  }
})

const { AppGate } = await import('@/components/AppGate')
const apiClient = await import('@lolipay/api-client')

describe('AppGate (admin)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.clearAllMocks()
  })

  it('shows the admin LoginScreen (Connect Wallet) when no token', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="admin-shell">ADMIN SHELL</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Connect Wallet')).toBeTruthy()
    })

    expect(screen.getByText('Approve LPs, manage config & orders.')).toBeTruthy()

    expect(screen.queryByTestId('admin-shell')).toBeNull()
    expect(screen.queryByText('LPs')).toBeNull()
    expect(screen.queryByText('Config')).toBeNull()
    expect(screen.queryByText('Orders')).toBeNull()
  })

  it('shows "Not authorized" when token exists but getAdminConfig returns 403', async () => {
    sessionStorage.setItem('lp_jwt', 'non-admin-jwt')

    const { ApiError } = await import('@lolipay/api-client')
    vi.mocked(apiClient.getAdminConfig).mockRejectedValueOnce(
      new ApiError(403, 'GET /admin/config → 403'),
    )

    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="admin-shell">ADMIN SHELL</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/Not authorized/i)).toBeTruthy()
    })

    expect(screen.getByText('Disconnect')).toBeTruthy()

    expect(screen.queryByTestId('admin-shell')).toBeNull()
    expect(screen.queryByText('LPs')).toBeNull()
  })

  it('shows the admin shell and nav when token exists and getAdminConfig resolves', async () => {
    sessionStorage.setItem('lp_jwt', 'admin-jwt')

    vi.mocked(apiClient.getAdminConfig).mockResolvedValueOnce({
      id: 1,
      spreadBps: 50,
      platformFeeBps: 30,
      lpFeeBps: 20,
      platformWallet: 'GAABC',
      minOrder: '1000000',
      maxOrder: '100000000',
      payWindowSecs: 900,
      confirmWindowSecs: 900,
      disputeWindowSecs: 86400,
      paused: false,
      updatedAt: new Date().toISOString(),
    } as any)

    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="admin-shell">ADMIN SHELL</div>
        </AppGate>
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('admin-shell')).toBeTruthy()
    })

    expect(screen.getByText('LPs')).toBeTruthy()
    expect(screen.getByText('Config')).toBeTruthy()
    expect(screen.getByText('Orders')).toBeTruthy()

    expect(screen.queryByText('Connect Wallet')).toBeNull()
    expect(screen.queryByText(/Not authorized/i)).toBeNull()
  })
})
