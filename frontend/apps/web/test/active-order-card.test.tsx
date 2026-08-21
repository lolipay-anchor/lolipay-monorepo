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

const getOrdersMock = vi.hoisted(() => vi.fn<() => Promise<Order[]>>(async () => []))
vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return { ...actual, getOrders: getOrdersMock }
})

const { ActiveOrderCard } = await import('@/components/ActiveOrderCard')

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

describe('ActiveOrderCard', () => {
  beforeEach(() => {
    sessionStorage.clear()
    queryClient.clear()
    getOrdersMock.mockReset()
    getOrdersMock.mockResolvedValue([])
  })

  it('renders nothing when unauthenticated', async () => {
    const { container } = render(
      <TestProviders>
        <ActiveOrderCard />
      </TestProviders>,
    )
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when there are no orders', async () => {
    authed()
    const { container } = render(
      <TestProviders>
        <ActiveOrderCard />
      </TestProviders>,
    )

    await new Promise((r) => setTimeout(r, 0))
    expect(container.querySelector('[href]')).toBeNull()
  })

  it('renders every non-hidden order simultaneously, keeps DISPUTED visible, and excludes RELEASED/CANCELLED/EXPIRED', async () => {
    authed()
    getOrdersMock.mockResolvedValue([
      makeOrder({ id: 'o1', status: 'FUNDED', flow: 'TOP_UP' }),
      makeOrder({ id: 'o2', status: 'FIAT_PAID', flow: 'WITHDRAW' }),
      makeOrder({ id: 'o3', status: 'MATCHED', flow: 'WITHDRAW' }),
      makeOrder({ id: 'o4', status: 'RELEASED' }),
      makeOrder({ id: 'o5', status: 'CANCELLED' }),
      makeOrder({ id: 'o6', status: 'DISPUTED' }),
      makeOrder({ id: 'o7', status: 'EXPIRED' }),
    ])

    render(
      <TestProviders>
        <ActiveOrderCard />
      </TestProviders>,
    )

    const labels = await screen.findAllByText('Active order')
    expect(labels).toHaveLength(4)

    expect(document.querySelector('a[href="/orders/o4"]')).toBeNull()
    expect(document.querySelector('a[href="/orders/o5"]')).toBeNull()
    expect(document.querySelector('a[href="/orders/o7"]')).toBeNull()

    expect(document.querySelector('a[href="/orders/o1"]')).toBeTruthy()
    expect(document.querySelector('a[href="/orders/o2"]')).toBeTruthy()
    expect(document.querySelector('a[href="/orders/o3"]')).toBeTruthy()

    const disputedLink = document.querySelector('a[href="/orders/o6"]')
    expect(disputedLink).toBeTruthy()
    const disputedPill = screen.getByText('Disputed')
    expect(disputedLink?.contains(disputedPill)).toBe(true)
    expect(disputedPill.className).toMatch(/bg-lp-danger-soft/)
  })

  it('shows the right status pill label per order state', async () => {
    authed()
    getOrdersMock.mockResolvedValue([
      makeOrder({ id: 'o1', status: 'CREATED' }),
      makeOrder({ id: 'o2', status: 'FUNDED' }),
      makeOrder({ id: 'o3', status: 'FIAT_PAID' }),
    ])

    render(
      <TestProviders>
        <ActiveOrderCard />
      </TestProviders>,
    )

    await screen.findAllByText('Active order')
    expect(screen.getByText('Matching')).toBeTruthy()
    expect(screen.getByText('In progress')).toBeTruthy()
    expect(screen.getByText('Confirming')).toBeTruthy()
  })

  it('shows the USDC amount and flow label for each order', async () => {
    authed()
    getOrdersMock.mockResolvedValue([
      makeOrder({ id: 'o1', status: 'FUNDED', flow: 'WITHDRAW', usdc_amount: '500000000' }),
    ])

    render(
      <TestProviders>
        <ActiveOrderCard />
      </TestProviders>,
    )

    expect(await screen.findByText(/50\.00/)).toBeTruthy()
    expect(screen.getByText(/^Sell/)).toBeTruthy()
  })
})
