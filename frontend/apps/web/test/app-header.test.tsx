import * as React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'

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
  useRouter: vi.fn(() => ({ back: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => '/'),
}))

const mockGetNotifications = vi.fn(async () => ({ unread: 0 }))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getNotifications: () => mockGetNotifications(),
  }
})

const { AppHeader } = await import('@/components/AppHeader')

const ADDR = 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X'

function authed() {
  sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
  sessionStorage.setItem('lp_addr', ADDR)
}

describe('AppHeader', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.clearAllMocks()
    mockGetNotifications.mockResolvedValue({ unread: 0 })

    queryClient.clear()
  })

  it('never shows a "Connect Wallet" button (login happens only on the LoginScreen)', () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader />
      </TestProviders>,
    )
    expect(screen.queryByText('Connect Wallet')).toBeNull()
  })

  it('shows the wallet pill for the authenticated address, linking to /profile', () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader />
      </TestProviders>,
    )

    expect(screen.getByText('GDCP…SC6X')).toBeTruthy()
    const link = screen.getByLabelText('Account and settings') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/profile')
  })

  it('shows the brand wordmark and logo tile when showBack is false (home)', () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader />
      </TestProviders>,
    )
    const brand = screen.getByText('lolipay')
    expect((brand.closest('a') as HTMLAnchorElement).getAttribute('href')).toBe('/')
  })

  it('shows a back button with the title instead of the brand when showBack is true', () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader showBack title="Buy USDC" />
      </TestProviders>,
    )
    const back = screen.getByLabelText('Go back')
    expect(back).toBeTruthy()
    expect(screen.queryByText('lolipay')).toBeNull()

    expect(screen.getByText('Buy USDC')).toBeTruthy()
  })

  it('expands the back button hit area to ~40px without changing the visible glyph size', () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader showBack title="Buy USDC" />
      </TestProviders>,
    )
    const back = screen.getByLabelText('Go back')

    expect(back.className).toContain('-m-2.5')
    expect(back.className).toContain('p-2.5')
    expect(back.className).not.toContain('p-0')
  })

  it('renders an optional title', () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader title="Buy USDC" showBack />
      </TestProviders>,
    )
    expect(screen.getByText('Buy USDC')).toBeTruthy()
  })

  it('does not show the unread dot when there are no unread notifications', async () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader />
      </TestProviders>,
    )
    await screen.findByLabelText('Notifications')
    expect(screen.queryByTestId('bell-dot')).toBeNull()
  })

  it('shows the unread dot on the notification bell when there are unread notifications', async () => {
    authed()
    mockGetNotifications.mockResolvedValue({ unread: 3 })
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader />
      </TestProviders>,
    )
    expect(await screen.findByTestId('bell-dot')).toBeTruthy()
  })
})
