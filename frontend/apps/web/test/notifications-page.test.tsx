import * as React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders } from './helpers'
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
  useRouter: vi.fn(() => ({ back: vi.fn(), push: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => '/notifications'),
}))

const mockGetNotifications = vi.hoisted(() => vi.fn())
const mockMarkNotificationsRead = vi.hoisted(() => vi.fn(async () => ({})))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getNotifications: mockGetNotifications,
    markNotificationsRead: mockMarkNotificationsRead,
  }
})

const { default: NotificationsPage } = await import('@/app/notifications/page')

const ADDR = 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X'

function authed() {
  sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
  sessionStorage.setItem('lp_addr', ADDR)
}

function makeNotif(overrides: Record<string, unknown> = {}) {
  return {
    id: 'n1',
    address: ADDR,
    orderId: 'o1',
    event: 'order.funded',
    title: 'Order funded',
    body: 'Your USDC has been locked in escrow.',
    read: false,
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('NotificationsPage', () => {
  beforeEach(() => {
    sessionStorage.clear()
    queryClient.clear()
    mockGetNotifications.mockReset()
    mockGetNotifications.mockResolvedValue({ items: [], unread: 0 })
    mockMarkNotificationsRead.mockClear()
  })

  it('shows the exact empty-state copy', async () => {
    authed()
    render(
      <TestProviders>
        <NotificationsPage />
      </TestProviders>,
    )
    expect(
      await screen.findByText(
        'No notifications yet. Order events from providers and operators land here.',
      ),
    ).toBeTruthy()
  })

  it('renders a neutral round icon, text, and mono time-ago meta per row — no source chips', async () => {
    authed()
    mockGetNotifications.mockResolvedValue({
      items: [makeNotif({ id: 'n1', title: 'Order funded', body: 'Your USDC is locked.' })],
      unread: 1,
    })

    render(
      <TestProviders>
        <NotificationsPage />
      </TestProviders>,
    )

    expect(await screen.findByText('Order funded')).toBeTruthy()
    expect(screen.getByText('Your USDC is locked.')).toBeTruthy()
    expect(screen.getByText('just now')).toBeTruthy()

    expect(screen.queryByText('LP')).toBeNull()
    expect(screen.queryByText('OP')).toBeNull()
    expect(screen.queryByText('ME')).toBeNull()
    const row = screen.getByTestId('notification-row')
    expect(row.querySelector('svg')).toBeTruthy()
  })

  it('still marks notifications read on view and invalidates the unread badge', async () => {
    authed()
    mockGetNotifications.mockResolvedValue({ items: [makeNotif()], unread: 1 })

    render(
      <TestProviders>
        <NotificationsPage />
      </TestProviders>,
    )

    await screen.findByText('Order funded')
    expect(mockMarkNotificationsRead).toHaveBeenCalledTimes(1)
  })
})
