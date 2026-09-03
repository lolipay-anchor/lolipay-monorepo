import * as React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
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
  usePathname: vi.fn(() => '/orders'),
  useRouter: vi.fn(() => ({ back: vi.fn() })),
  useSearchParams: vi.fn(() => ({ get: () => null })),
}))
vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    authenticate: vi.fn(async () => {
      sessionStorage.setItem('lp_jwt', 'fake-jwt')
    }),
    getAdminOrders: vi.fn(),
    getAdminConfig: vi.fn(),
    getLps: vi.fn(),
    downloadOrderProof: vi.fn(),
    downloadDisputeEvidence: vi.fn(),
    getAdminOrderRisk: vi.fn(),
    attestFiatPaid: vi.fn(),
  }
})

const OrdersPage = (await import('@/app/orders/page')).default
const apiClient = await import('@lolipay/api-client')
const { queryClient } = await import('@/app/providers')
const { client } = await import('@/lib/client')

function makeOrder(overrides: Partial<import('@lolipay/api-client').Order> = {}) {
  return {
    id: 'order-attest-1',
    trade_id: 'a'.repeat(64),
    user_address: 'GUSERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    lp_wallet: 'GLPXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    flow: 'TOP_UP' as const,
    rail: 'BANK' as const,
    usdc_amount: '50000000',
    fiat_amount: '82500',
    fiat_currency: 'IDR',
    rate_snapshot: '16500',
    platform_fee_bps: 30,
    lp_fee_bps: 20,
    status: 'FUNDED' as const,
    pay_deadline: Math.floor(Date.now() / 1000) + 1800,
    confirm_deadline: Math.floor(Date.now() / 1000) + 3600,
    dispute_deadline: Math.floor(Date.now() / 1000) + 90000,
    expires_at: '2024-01-16T10:00:00.000Z',
    created_at: '2024-01-15T10:00:00.000Z',
    ...overrides,
  }
}

const DEFAULT_RISK = {
  wallet_age_days: 30,
  user_dispute_velocity_30d: 0,
  lp_dispute_velocity_30d: 0,
  amount_vs_tier_limit: { order_usdc: 5, tier: 'BRONZE' as const, daily_limit_usdc: 100, ratio: 0.05 },
  lp_completion: {
    completed_trades: 10,
    completion_rate: 0.9,
    member_since: '2026-01-01T00:00:00Z',
    online: true,
  },
}

function mount() {
  return render(
    <TestProviders kit={fakeKit}>
      <OrdersPage />
    </TestProviders>,
  )
}

describe('the operator can attest that rupiah arrived, from the orders page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    queryClient.clear()
    vi.mocked(apiClient.getAdminOrderRisk).mockResolvedValue(DEFAULT_RISK)
    vi.mocked(apiClient.attestFiatPaid).mockResolvedValue({ orderId: 'order-attest-1', submission: 'SUCCESS', txHash: 'b'.repeat(64) })
  })

  it('offers the attestation only on the funded deposit, and names that order inside the panel', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValue([
      makeOrder({ ref: 'LP-FUND' }),
      makeOrder({ id: 'order-paid', status: 'FIAT_PAID', ref: 'LP-PAID' }),
      makeOrder({ id: 'order-withdraw', flow: 'WITHDRAW', ref: 'LP-WDRW' }),
    ])
    mount()
    await waitFor(() => {
      expect(screen.getAllByTestId('order-ref')).toHaveLength(3)
    })
    expect(screen.getAllByTestId('attest-fiat-paid')).toHaveLength(1)
    expect(screen.getByTestId('attest-ref').textContent).toBe('LP-FUND')
    expect(screen.getByTestId('attest-panel').textContent).toContain('82,500')
  })

  it('will not submit a reference made of whitespace', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValue([makeOrder()])
    mount()
    const button = await waitFor(() => screen.getByTestId('attest-fiat-paid'))
    fireEvent.change(screen.getByTestId('attest-evidence'), { target: { value: '     ' } })
    expect((button as HTMLButtonElement).disabled).toBe(true)
  })

  it('replaces the form with the transaction once the chain accepted, so a second press has nothing to press', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValue([makeOrder()])
    mount()
    const button = await waitFor(() => screen.getByTestId('attest-fiat-paid'))
    fireEvent.change(screen.getByTestId('attest-evidence'), { target: { value: 'BCA 12345' } })
    fireEvent.click(button)
    await waitFor(() => {
      expect(screen.getByTestId('attest-done').textContent).toContain('b'.repeat(64))
    })
    expect(screen.queryByTestId('attest-fiat-paid')).toBeNull()
    expect(apiClient.getAdminOrders).toHaveBeenCalledTimes(2)
  })

  it('offers nothing once the attestation window has closed, because the contract would refuse it and the escrow will refund', async () => {
    const past = Math.floor(Date.now() / 1000) - 7200
    vi.mocked(apiClient.getAdminOrders).mockResolvedValue([makeOrder({ ref: 'LP-LATE', pay_deadline: past, confirm_deadline: past })])
    mount()
    await waitFor(() => {
      expect(screen.getByTestId('order-ref').textContent).toBe('LP-LATE')
    })
    expect(screen.queryByTestId('attest-panel')).toBeNull()
    expect(screen.queryByTestId('attest-fiat-paid')).toBeNull()
  })

  it('refuses to submit without a bank reference, so an attestation always carries what was checked', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValue([makeOrder()])
    mount()
    const button = await waitFor(() => screen.getByTestId('attest-fiat-paid'))
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(button)
    expect(apiClient.attestFiatPaid).not.toHaveBeenCalled()
  })

  it('attests with the reference the operator typed, against this order', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValue([makeOrder()])
    mount()
    const button = await waitFor(() => screen.getByTestId('attest-fiat-paid'))
    fireEvent.change(screen.getByTestId('attest-evidence'), { target: { value: '  BCA 12345  ' } })
    expect((button as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(button)
    await waitFor(() => {
      expect(apiClient.attestFiatPaid).toHaveBeenCalledWith(client, 'order-attest-1', 'BCA 12345')
    })
  })

  it('shows the coordinator refusal instead of swallowing it', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValue([makeOrder()])
    vi.mocked(apiClient.attestFiatPaid).mockRejectedValue(new Error('this order is not FUNDED'))
    mount()
    const button = await waitFor(() => screen.getByTestId('attest-fiat-paid'))
    fireEvent.change(screen.getByTestId('attest-evidence'), { target: { value: 'BCA 12345' } })
    fireEvent.click(button)
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/not FUNDED/)
    })
  })
})
