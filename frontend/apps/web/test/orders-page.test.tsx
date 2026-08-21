import * as React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Order } from '@lolipay/api-client'
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
  usePathname: vi.fn(() => '/orders'),
}))

const getOrdersMock = vi.hoisted(() => vi.fn<() => Promise<Order[]>>(async () => []))
const mockGetNotifications = vi.hoisted(() => vi.fn(async () => ({ unread: 0 })))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return { ...actual, getOrders: getOrdersMock, getNotifications: mockGetNotifications }
})

const { default: OrdersPage } = await import('@/app/orders/page')

const ADDR = 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X'

function authed() {
  sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
  sessionStorage.setItem('lp_addr', ADDR)
}

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'o1',
    trade_id: 't1',
    user_address: ADDR,
    lp_wallet: 'GLP',
    flow: 'TOP_UP',
    rail: 'BANK',
    usdc_amount: '1000000000',
    fiat_amount: '1600000',
    fiat_currency: 'IDR',
    rate_snapshot: '16000',
    platform_fee_bps: 30,
    lp_fee_bps: 120,
    status: 'FUNDED',
    pay_deadline: 0,
    confirm_deadline: 0,
    dispute_deadline: 0,
    expires_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('OrdersPage', () => {
  beforeEach(() => {
    sessionStorage.clear()
    queryClient.clear()
    getOrdersMock.mockReset()
    getOrdersMock.mockResolvedValue([])
    mockGetNotifications.mockReset()
    mockGetNotifications.mockResolvedValue({ unread: 0 })
  })

  it('shows the reskinned empty state with the existing copy and CTA', async () => {
    authed()
    render(
      <TestProviders>
        <OrdersPage />
      </TestProviders>,
    )
    expect(await screen.findByText('No orders yet.')).toBeTruthy()
    const cta = screen.getByText('Start your first trade').closest('a') as HTMLAnchorElement
    expect(cta.getAttribute('href')).toBe('/buy')
  })

  it('renders the flow-specific icon tile per order (TOP_UP/WITHDRAW)', async () => {
    authed()
    getOrdersMock.mockResolvedValue([
      makeOrder({ id: 'o1', flow: 'TOP_UP', status: 'RELEASED' }),
      makeOrder({ id: 'o2', flow: 'WITHDRAW', status: 'FUNDED' }),
    ])

    render(
      <TestProviders>
        <OrdersPage />
      </TestProviders>,
    )

    const topUpIcon = await screen.findByTestId('order-icon-TOP_UP')
    expect(topUpIcon.className).toMatch(/bg-lp-green-soft/)
    expect(topUpIcon.querySelector('svg')?.getAttribute('class')).toMatch(/text-lp-green\b/)

    const withdrawIcon = screen.getByTestId('order-icon-WITHDRAW')
    expect(withdrawIcon.className).toMatch(/bg-lp-line-2/)
    expect(withdrawIcon.querySelector('svg')?.getAttribute('class')).toMatch(/text-lp-ink\b/)
  })

  it('shows the flow title, USDC + time-ago sub line, and status pill', async () => {
    authed()
    getOrdersMock.mockResolvedValue([
      makeOrder({ id: 'o1', flow: 'TOP_UP', status: 'RELEASED', usdc_amount: '297900000' }),
    ])

    render(
      <TestProviders>
        <OrdersPage />
      </TestProviders>,
    )

    expect(await screen.findByText('Buy USDC')).toBeTruthy()
    expect(screen.getByText(/29\.79 USDC · /)).toBeTruthy()
    expect(screen.getByText('Released')).toBeTruthy()
  })

  it('dims terminal orders with opacity-[.72] except for DISPUTED, and leaves non-terminal ones fully opaque', async () => {
    authed()
    getOrdersMock.mockResolvedValue([
      makeOrder({ id: 'o1', status: 'RELEASED' }),
      makeOrder({ id: 'o2', status: 'FUNDED' }),
      makeOrder({ id: 'o3', status: 'DISPUTED' }),
    ])

    render(
      <TestProviders>
        <OrdersPage />
      </TestProviders>,
    )

    const rows = await screen.findAllByTestId('order-row')
    expect(rows).toHaveLength(3)
    const released = rows.find((r) => r.getAttribute('href') === '/orders/o1')!
    const funded = rows.find((r) => r.getAttribute('href') === '/orders/o2')!
    const disputed = rows.find((r) => r.getAttribute('href') === '/orders/o3')!
    expect(released.className).toMatch(/opacity-\[\.72\]/)
    expect(funded.className).not.toMatch(/opacity-\[\.72\]/)
    expect(disputed.className).not.toMatch(/opacity-\[\.72\]/)
  })

  it('links each card to its order detail page', async () => {
    authed()
    getOrdersMock.mockResolvedValue([makeOrder({ id: 'abc123' })])

    render(
      <TestProviders>
        <OrdersPage />
      </TestProviders>,
    )

    const row = await screen.findByTestId('order-row')
    expect(row.getAttribute('href')).toBe('/orders/abc123')
  })
})
