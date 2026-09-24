import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders } from './helpers'
import { queryClient } from '@/app/providers'
import type { Order } from '@lolipay/api-client'
import type { ActiveCountdown } from '@/lib/steps'

vi.mock('@/lib/wallet-kit', () => ({
  getDefaultKit: vi.fn(() => ({})),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))

const mockGetOrder = vi.hoisted(() => vi.fn())
vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getOrder: mockGetOrder,
  }
})

const mockActiveCountdown = vi.hoisted(() => vi.fn<() => ActiveCountdown | null>())
vi.mock('@/lib/steps', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/steps')>()
  return {
    ...actual,
    activeCountdown: mockActiveCountdown,
  }
})

const { OrderStatus: OrderStatusComponent } = await import('@/components/OrderStatus')

const SENTINEL_LABEL = 'ZZ_SENTINEL_LABEL_a1b2c3'
const SENTINEL_VALUE = 'ZZ_SENTINEL_VALUE_9f3a1c2'

const BASE_ORDER: Order = {
  id: 'ord-1',
  trade_id: 'tr-1',
  user_address: 'GDXXX',
  lp_wallet: 'GDYYY',
  flow: 'TOP_UP' as const,
  rail: 'BANK' as const,
  usdc_amount: '1000000000',
  fiat_amount: '1600000',
  fiat_currency: 'IDR',
  rate_snapshot: '16000',
  platform_fee_bps: 30,
  lp_fee_bps: 120,
  status: 'FUNDED' as const,
  pay_deadline: Math.floor(Date.now() / 1000) + 3600,
  confirm_deadline: Math.floor(Date.now() / 1000) + 7200,
  refund_opens_at: Math.floor(Date.now() / 1000) + 7200,
  dispute_deadline: Math.floor(Date.now() / 1000) + 86400,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  created_at: new Date().toISOString(),
}

describe("OrderStatus expired countdown row renders the window's own value, not a hardcoded literal", () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  it('renders the exact label and value activeCountdown() returned, never a hardcoded literal', async () => {
    const now = Math.floor(Date.now() / 1000)
    mockActiveCountdown.mockReturnValue({
      label: SENTINEL_LABEL,
      value: SENTINEL_VALUE,
      expired: true,
    } satisfies ActiveCountdown)

    const order: Order = {
      ...BASE_ORDER,
      id: 'ord-expired-sentinel',
      flow: 'WITHDRAW',
      status: 'FUNDED',
      confirm_deadline: now - 60,
      refund_opens_at: now - 60,
    }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-expired-sentinel" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(SENTINEL_VALUE)).toBeTruthy()
    })

    expect(screen.getByText(SENTINEL_LABEL)).toBeTruthy()
  })
})
