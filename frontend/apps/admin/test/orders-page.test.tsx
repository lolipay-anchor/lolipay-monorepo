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
  }
})

const OrdersPage = (await import('@/app/orders/page')).default
const apiClient = await import('@lolipay/api-client')
const { queryClient } = await import('@/app/providers')

const MOCK_ORDER = {
  id: 'order-1',
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

describe('Orders page', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
    queryClient.clear()
    vi.mocked(apiClient.getAdminOrderRisk).mockResolvedValue(DEFAULT_RISK)

    ;(URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = vi.fn(
      () => 'blob:mock-url',
    )
    ;(URL as unknown as { revokeObjectURL: (u: string) => void }).revokeObjectURL = vi.fn()

    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
  })

  it('renders a mocked order with usdc amount, fiat amount, and status', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([MOCK_ORDER])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/5\.00/)).toBeTruthy()
    })

    expect(screen.getByText(/82,500/)).toBeTruthy()

    const fundedEls = screen.getAllByText('FUNDED')
    expect(fundedEls.length).toBeGreaterThanOrEqual(1)

    const badge = fundedEls.find((el) => el.className.includes('rounded-lp-pill'))
    expect(badge).toBeTruthy()
  })

  it('renders flow and rail', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([MOCK_ORDER])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/TOP_UP/)).toBeTruthy()
    })

    expect(screen.getByText(/BANK/)).toBeTruthy()
  })

  it('renders truncated user and LP addresses', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([MOCK_ORDER])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/GUSER1/)).toBeTruthy()
    })
  })

  it('shows empty state when no orders', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('No orders found.')).toBeTruthy()
    })
  })

  it('shows loading state', () => {
    vi.mocked(apiClient.getAdminOrders).mockReturnValueOnce(new Promise(() => {}))

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    expect(screen.getByText('Loading…')).toBeTruthy()
  })

  it('shows RELEASED status with ok tone', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([
      { ...MOCK_ORDER, status: 'RELEASED' as const },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('RELEASED')).toBeTruthy()
    })
  })

  it('shows the ref chip when the order carries a TOP_UP transfer ref', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([
      { ...MOCK_ORDER, ref: 'LP-AB12' },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('order-ref')).toHaveTextContent('LP-AB12')
    })
  })

  it('omits the ref chip and proof download when neither is present', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([MOCK_ORDER])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/5\.00/)).toBeTruthy()
    })
    expect(screen.queryByTestId('order-ref')).toBeNull()
    expect(screen.queryByTestId('download-proof')).toBeNull()
  })

  it('downloads payment proof via an authenticated blob fetch when proof_url is present', async () => {
    const mockBlob = new Blob(['bytes'], { type: 'image/jpeg' })
    vi.mocked(apiClient.downloadOrderProof).mockResolvedValueOnce(mockBlob)
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([
      { ...MOCK_ORDER, proof_url: 'proofs/abc.jpg' },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('download-proof'))
    fireEvent.click(screen.getByTestId('download-proof'))

    await waitFor(() => {
      expect(apiClient.downloadOrderProof).toHaveBeenCalledWith(expect.anything(), 'order-1')
    })
  })

  const DISPUTED_ORDER = {
    ...MOCK_ORDER,
    status: 'DISPUTED' as const,
    dispute_by: 'user' as const,
    dispute_reason: 'PAYMENT_NOT_RECEIVED' as const,
    dispute_note: 'Never got the transfer confirmation',
    dispute_evidence_url: 'evidence/order-1-user.png',
  }

  it('shows the humanized dispute reason, note, and filer for a DISPUTED order', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([DISPUTED_ORDER])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('dispute-panel')).toBeTruthy()
    })
    expect(screen.getByText(/Payment not received/i)).toBeTruthy()
    expect(screen.getByText(/Never got the transfer confirmation/i)).toBeTruthy()
    expect(screen.getByTestId('dispute-panel')).toHaveTextContent('Filed by: user')
  })

  it('downloads dispute evidence via an authenticated blob fetch', async () => {
    const mockBlob = new Blob(['bytes'], { type: 'image/png' })
    vi.mocked(apiClient.downloadDisputeEvidence).mockResolvedValueOnce(mockBlob)
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([DISPUTED_ORDER])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('download-evidence'))
    fireEvent.click(screen.getByTestId('download-evidence'))

    await waitFor(() => {
      expect(apiClient.downloadDisputeEvidence).toHaveBeenCalledWith(expect.anything(), 'order-1')
    })
  })

  it('omits the evidence download button when no evidence was attached', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([
      { ...DISPUTED_ORDER, dispute_evidence_url: null },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('dispute-panel')).toBeTruthy()
    })
    expect(screen.queryByTestId('download-evidence')).toBeNull()
  })

  it('WITHDRAW dispute: shows the payment cross-check and flags an amount mismatch', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([
      {
        ...DISPUTED_ORDER,
        flow: 'WITHDRAW' as const,
        fiat_amount: '25000',
        merchant: 'Warung Kopi',
        proof_rrn: 'REF12345',
        proof_amount: '20000',
        proof_paid_at: '2026-07-09T10:00:00.000Z',
        proof_url: 'proofs/abc.jpg',
      },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByTestId('proof-crosscheck')).toBeTruthy())
    const panel = screen.getByTestId('proof-crosscheck')
    expect(panel).toHaveTextContent('REF12345')
    expect(panel).toHaveTextContent(/mismatch/i)
    expect(screen.getByTestId('download-receipt')).toBeTruthy()
  })

  it('shows the "Post-settlement dispute" badge when the order has settled_at and is DISPUTED', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([
      { ...DISPUTED_ORDER, settled_at: '2024-01-16T12:00:00.000Z' },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('post-settlement-badge')).toBeTruthy()
    })
  })

  it('does NOT show the post-settlement badge for a pre-settlement (FIAT_PAID → raised) dispute', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([
      { ...DISPUTED_ORDER, settled_at: null },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('dispute-panel')).toBeTruthy()
    })
    expect(screen.queryByTestId('post-settlement-badge')).toBeNull()
  })

  it('shows ResolveActions alongside the dispute panel for a DISPUTED order', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([DISPUTED_ORDER])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('resolve-release')).toBeTruthy()
    })
    expect(screen.getByTestId('resolve-refund')).toBeTruthy()
  })

  it('ResolveActions labels are flow-aware (design handoff): TOP_UP releases to the user, refunds the LP', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([DISPUTED_ORDER])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    const release = await screen.findByTestId('resolve-release')
    const refund = screen.getByTestId('resolve-refund')

    expect(release.className).toContain('flex-1')
    expect(refund.className).toContain('flex-1')
    expect(release.textContent).toBe('Release to user')
    expect(refund.textContent).toBe('Refund to LP')
  })

  it('ResolveActions labels flip for WITHDRAW (user escrowed → release pays the LP)', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([
      { ...DISPUTED_ORDER, flow: 'WITHDRAW' as const },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    expect((await screen.findByTestId('resolve-release')).textContent).toBe('Release to LP')
    expect(screen.getByTestId('resolve-refund').textContent).toBe('Refund to user')
  })

  it('a RESOLVED historical dispute does NOT render as an open dispute (dispute_by survives resolution)', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([
      {
        ...DISPUTED_ORDER,
        status: 'RELEASED' as const,
        resolution: 'released',
        dispute_at: '2026-07-01T10:00:00.000Z',
        settled_at: '2026-07-01T12:00:00.000Z',
      },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByText(/RELEASED/i)).toBeTruthy())
    expect(screen.queryByTestId('dispute-panel')).toBeNull()
    expect(screen.queryByTestId('awaiting-onchain-badge')).toBeNull()
  })

  it('a NEW post-settlement filing on an already-resolved order still shows the panel (dispute_at postdates settled_at)', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([
      {
        ...DISPUTED_ORDER,
        status: 'RELEASED' as const,
        resolution: 'released',
        settled_at: '2026-07-01T12:00:00.000Z',
        dispute_at: '2026-07-01T12:30:00.000Z',
      },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByTestId('dispute-panel')).toBeTruthy())
    expect(screen.getByTestId('post-settlement-badge')).toBeTruthy()
  })

  it('a FILED dispute whose raise_dispute has not landed on-chain still shows the panel with an awaiting badge (no resolve yet)', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([

      { ...DISPUTED_ORDER, status: 'FIAT_PAID' as const },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByTestId('dispute-panel')).toBeTruthy())
    expect(screen.getByTestId('awaiting-onchain-badge')).toBeTruthy()

    expect(screen.queryByTestId('resolve-release')).toBeNull()
  })

  it('shows a loading state for risk chips before the risk endpoint resolves', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([DISPUTED_ORDER])
    vi.mocked(apiClient.getAdminOrderRisk).mockReturnValue(new Promise(() => {}))

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('risk-loading')).toBeTruthy()
    })
    expect(screen.queryByTestId('risk-chips')).toBeNull()
  })

  it('shows an error state when the risk endpoint fails', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([DISPUTED_ORDER])
    vi.mocked(apiClient.getAdminOrderRisk).mockRejectedValueOnce(new Error('boom'))

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('risk-error')).toBeTruthy()
    })
    expect(screen.queryByTestId('risk-chips')).toBeNull()
  })

  it('renders wallet age, dispute velocity, amount-vs-limit, and LP completion chips', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([DISPUTED_ORDER])
    vi.mocked(apiClient.getAdminOrderRisk).mockResolvedValueOnce({
      wallet_age_days: 12,
      user_dispute_velocity_30d: 2,
      lp_dispute_velocity_30d: 1,
      amount_vs_tier_limit: { order_usdc: 80, tier: 'BRONZE', daily_limit_usdc: 100, ratio: 0.8 },
      lp_completion: { completed_trades: 44, completion_rate: 0.95, member_since: '2026-01-01T00:00:00Z', online: true },
    })

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('risk-chips')).toBeTruthy()
    })
    expect(screen.getByTestId('risk-wallet-age')).toHaveTextContent('12d')
    expect(screen.getByTestId('risk-user-disputes')).toHaveTextContent('2')
    expect(screen.getByTestId('risk-lp-disputes')).toHaveTextContent('1')
    expect(screen.getByTestId('risk-amount-vs-limit')).toHaveTextContent('0.80')
    expect(screen.getByTestId('risk-lp-completion')).toHaveTextContent('44 trades')
    expect(screen.getByTestId('risk-lp-completion')).toHaveTextContent('95%')
  })

  it('renders a NULL wallet age as "unknown — treat as high risk" in the danger tone, never as safe', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([DISPUTED_ORDER])
    vi.mocked(apiClient.getAdminOrderRisk).mockResolvedValueOnce({
      wallet_age_days: null,
      user_dispute_velocity_30d: 0,
      lp_dispute_velocity_30d: 0,
      amount_vs_tier_limit: { order_usdc: 5, tier: 'BRONZE', daily_limit_usdc: 100, ratio: 0.05 },
      lp_completion: null,
    })

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    const chip = await screen.findByTestId('risk-wallet-age')
    expect(chip).toHaveTextContent(/unknown/i)
    expect(chip).toHaveTextContent(/high risk/i)
    expect(chip.className).toContain('text-lp-danger')
    expect(chip.className).not.toContain('text-lp-ink-soft')
  })

  it('highlights amount-vs-limit in the danger tone when the ratio exceeds 1×', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([DISPUTED_ORDER])
    vi.mocked(apiClient.getAdminOrderRisk).mockResolvedValueOnce({
      wallet_age_days: 100,
      user_dispute_velocity_30d: 0,
      lp_dispute_velocity_30d: 0,
      amount_vs_tier_limit: { order_usdc: 150, tier: 'BRONZE', daily_limit_usdc: 100, ratio: 1.5 },
      lp_completion: null,
    })

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    const chip = await screen.findByTestId('risk-amount-vs-limit')
    expect(chip).toHaveTextContent('1.50')
    expect(chip.className).toContain('text-lp-danger')
  })

  it('omits the LP-completion chip when there is no LP yet (e.g. no provider matched yet)', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([DISPUTED_ORDER])
    vi.mocked(apiClient.getAdminOrderRisk).mockResolvedValueOnce({
      wallet_age_days: 5,
      user_dispute_velocity_30d: 0,
      lp_dispute_velocity_30d: 0,
      amount_vs_tier_limit: { order_usdc: 5, tier: 'BRONZE', daily_limit_usdc: 100, ratio: 0.05 },
      lp_completion: null,
    })

    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('risk-chips')).toBeTruthy()
    })
    expect(screen.queryByTestId('risk-lp-completion')).toBeNull()
  })
})

describe('a settled order links its transaction', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  it('renders a stellar.expert link to the settlement transaction when the order carries its hash', async () => {
    const hash = 'ef'.repeat(32)
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([
      { ...MOCK_ORDER, id: 'order-settled', status: 'RELEASED' as const, settled_at: '2026-09-07T10:23:07.000Z', settlement_tx_hash: hash },
    ])
    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('settlement-link')).toBeTruthy()
    })
    const link = screen.getByTestId('settlement-link') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe(`https://stellar.expert/explorer/testnet/tx/${hash}`)
    expect(link.textContent).toBe('View transaction ↗')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('renders no link for an order that has not settled', async () => {
    vi.mocked(apiClient.getAdminOrders).mockResolvedValueOnce([{ ...MOCK_ORDER, settlement_tx_hash: null }])
    render(
      <TestProviders kit={fakeKit}>
        <OrdersPage />
      </TestProviders>,
    )
    await waitFor(() => {
      expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0)
    })
    expect(screen.queryByTestId('settlement-link')).toBeNull()
  })
})
