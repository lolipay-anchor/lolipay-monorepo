import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { makeFakeSocket, type FakeSocket } from './realtime-helpers'

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
  usePathname: vi.fn(() => '/orders'),
  useRouter: vi.fn(() => ({ back: vi.fn() })),
  useSearchParams: vi.fn(() => ({ get: () => null })),
}))

let lastSocket: FakeSocket
const mockIo = vi.hoisted(() => vi.fn())
vi.mock('socket.io-client', () => ({ io: mockIo }))

const mockGetAdminOrders = vi.hoisted(() => vi.fn())
const mockGetNotifications = vi.hoisted(() => vi.fn(async () => ({ unread: 0 })))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getAdminOrders: mockGetAdminOrders,
    getNotifications: mockGetNotifications,
    getAdminOrderRisk: vi.fn(),
  }
})

const OrdersPage = (await import('@/app/orders/page')).default

const MOCK_ORDER = {
  id: 'order-rt-1',
  trade_id: 'trade-abc',
  user_address: 'GUSER111AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  lp_wallet: 'GLPWALLET222AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  flow: 'TOP_UP' as const,
  rail: 'BANK' as const,
  usdc_amount: '50000000',
  fiat_amount: '82500',
  fiat_currency: 'IDR',
  rate_snapshot: '16500',
  platform_fee_bps: 30,
  lp_fee_bps: 20,
  status: 'FUNDED' as const,
  pay_deadline: 1700000000,
  confirm_deadline: 1700003600,
  dispute_deadline: 1700090000,
  expires_at: '2024-01-16T10:00:00.000Z',
  created_at: '2024-01-15T10:00:00.000Z',
}

function authed() {
  sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
  sessionStorage.setItem('lp_addr', 'GADMIN')
}

describe('Orders page — realtime wiring', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mockIo.mockReset()
    mockGetAdminOrders.mockReset()
    lastSocket = makeFakeSocket()
    mockIo.mockImplementation(() => lastSocket)
  })

  it('never emits join:order for listed orders — admin relies on the auto-joined admin:orders room instead (gate fix wave Task 6 Fix 3)', async () => {
    authed()
    mockGetAdminOrders.mockResolvedValue([MOCK_ORDER])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByText(/5\.00/)).toBeTruthy())
    lastSocket.__trigger('connect')
    expect(lastSocket.emit).not.toHaveBeenCalledWith('join:order', expect.anything())
  })

  it('refetches the orders list when order:update arrives (via the admin-wide room, no join:order needed)', async () => {
    authed()
    mockGetAdminOrders.mockResolvedValue([MOCK_ORDER])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => expect(mockGetAdminOrders).toHaveBeenCalled())
    mockGetAdminOrders.mockClear()

    lastSocket.__trigger('order:update', {
      id: 'order-rt-1',
      status: 'DISPUTED',
      flow: 'TOP_UP',
      updated_at: new Date().toISOString(),
    })

    await waitFor(() => expect(mockGetAdminOrders).toHaveBeenCalled())
  })

  it('still renders the list when the socket never connects (pure polling/manual-refresh fallback)', async () => {
    authed()
    mockGetAdminOrders.mockResolvedValue([MOCK_ORDER])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => expect(mockGetAdminOrders).toHaveBeenCalled())
  })
})
