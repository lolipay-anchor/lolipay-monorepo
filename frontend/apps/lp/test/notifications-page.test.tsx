import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
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

describe('NotificationsPage (LP)', () => {
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
      <TestProviders kit={fakeKit}>
        <NotificationsPage />
      </TestProviders>,
    )
    expect(
      await screen.findByText(
        'No notifications yet. Order events from providers and operators land here.',
      ),
    ).toBeTruthy()
  })

  it('renders a fetched notification title and body, not an empty list', async () => {
    authed()
    mockGetNotifications.mockResolvedValue({
      items: [makeNotif({ title: 'Order funded', body: 'Your USDC is locked.' })],
      unread: 1,
    })

    render(
      <TestProviders kit={fakeKit}>
        <NotificationsPage />
      </TestProviders>,
    )

    expect(await screen.findByText('Order funded')).toBeTruthy()
    expect(screen.getByText('Your USDC is locked.')).toBeTruthy()
  })

  it('does not mark notifications read until the fetched list has been shown', async () => {
    authed()
    let resolveNotifications: (v: { items: unknown[]; unread: number }) => void = () => {}
    mockGetNotifications.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveNotifications = resolve
        }),
    )

    render(
      <TestProviders kit={fakeKit}>
        <NotificationsPage />
      </TestProviders>,
    )

    await waitFor(() => expect(mockGetNotifications).toHaveBeenCalled())
    expect(mockMarkNotificationsRead).not.toHaveBeenCalled()

    resolveNotifications({ items: [makeNotif()], unread: 1 })

    expect(await screen.findByText('Order funded')).toBeTruthy()
    expect(mockMarkNotificationsRead).toHaveBeenCalledTimes(1)
  })
})
