import * as React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Order } from '@lolipay/api-client'
import { TestProviders } from './helpers'
import { queryClient } from '@/app/providers'

vi.mock('@/lib/wallet-kit', () => ({
  getDefaultKit: vi.fn(() => ({})),
}))

const push = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: vi.fn(() => ({ back: vi.fn(), push })),
  usePathname: vi.fn(() => '/'),
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
  return {
    ...actual,
    getRate: vi.fn(async () => ({
      asset: 'USDC',
      fiat: 'IDR',
      rate: '18123.231',
      ts: 't',
    })),
    getOrders: getOrdersMock,
  }
})

vi.mock('@/hooks/useUsdcBalance', () => ({
  useUsdcBalance: vi.fn(() => ({
    balance: undefined,
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  })),
}))

const { default: Home } = await import('@/app/page')

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

describe('Home', () => {
  beforeEach(() => {
    sessionStorage.clear()
    queryClient.clear()
    push.mockClear()
    getOrdersMock.mockReset()
    getOrdersMock.mockResolvedValue([])
  })

  it('renders the live rate and the Buy action tile', async () => {
    render(
      <TestProviders>
        <Home />
      </TestProviders>,
    )

    expect(await screen.findByText('Rp 18.123')).toBeTruthy()

    expect(screen.getByText('Buy')).toBeTruthy()
  })

  it('does not render the active-order stack when no token is present', async () => {
    render(
      <TestProviders>
        <Home />
      </TestProviders>,
    )

    await screen.findByText('Rp 18.123')
    expect(screen.queryByText(/active order/i)).toBeNull()
  })

  it('navigates to /buy and /sell when the action tiles are clicked', async () => {
    render(
      <TestProviders>
        <Home />
      </TestProviders>,
    )
    await screen.findByText('Rp 18.123')

    screen.getByText('Buy').closest('button')!.click()
    expect(push).toHaveBeenCalledWith('/buy')

    screen.getByText('Sell').closest('button')!.click()
    expect(push).toHaveBeenCalledWith('/sell')
  })

  it('renders every non-terminal order and hides terminal ones', async () => {
    authed()
    getOrdersMock.mockResolvedValue([
      makeOrder({ id: 'o1', status: 'FUNDED' }),
      makeOrder({ id: 'o2', status: 'FIAT_PAID', flow: 'WITHDRAW' }),
      makeOrder({ id: 'o3', status: 'RELEASED' }),
    ])

    render(
      <TestProviders>
        <Home />
      </TestProviders>,
    )

    const cards = await screen.findAllByText('Active order')
    expect(cards).toHaveLength(2)
  })

  it('shows the trust row', async () => {
    render(
      <TestProviders>
        <Home />
      </TestProviders>,
    )
    await screen.findByText('Rp 18.123')
    expect(screen.getByText('Non-custodial')).toBeTruthy()
    expect(screen.getByText('Escrow secured')).toBeTruthy()
    expect(screen.getByText('Paid in ~2 min')).toBeTruthy()
  })
})
