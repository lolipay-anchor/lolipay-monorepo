import * as React from 'react'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders } from './helpers'
import type { Order } from '@lolipay/api-client'

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

const mockPush = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, back: vi.fn() }),
}))

const mockGetOrder = vi.hoisted(() => vi.fn())
const mockCancelOrder = vi.hoisted(() => vi.fn())

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getOrder: mockGetOrder,
    cancelOrder: mockCancelOrder,
  }
})

const { stepsFor, isTerminal } = await import('@/lib/steps')
const { OrderStatus: OrderStatusComponent } = await import('@/components/OrderStatus')

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
  dispute_deadline: Math.floor(Date.now() / 1000) + 86400,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  created_at: new Date().toISOString(),
}

describe('stepsFor', () => {
  it('FUNDED: step[0]=done, [1]=done, [2]=now, [3]=pending', () => {
    const steps = stepsFor('FUNDED')
    expect(steps[0].state).toBe('done')
    expect(steps[1].state).toBe('done')
    expect(steps[2].state).toBe('now')
    expect(steps[3].state).toBe('pending')
  })

  it('RELEASED: all steps done', () => {
    const steps = stepsFor('RELEASED')
    expect(steps.every((s) => s.state === 'done')).toBe(true)
  })

  it('MATCHED: step[1]=now', () => {
    const steps = stepsFor('MATCHED')
    expect(steps[1].state).toBe('now')
  })

  it('CREATED: step[0]=done, rest pending', () => {
    const steps = stepsFor('CREATED')
    expect(steps[0].state).toBe('done')
    expect(steps[1].state).toBe('now')
  })

  it('AWAITING_ONCHAIN: step[1]=now', () => {
    const steps = stepsFor('AWAITING_ONCHAIN')
    expect(steps[1].state).toBe('now')
  })

  it('FIAT_PAID: step[2]=done, step[3]=now', () => {
    const steps = stepsFor('FIAT_PAID')
    expect(steps[2].state).toBe('done')
    expect(steps[3].state).toBe('now')
  })

  it('CANCELLED: first step done, rest pending (terminal failure)', () => {
    const steps = stepsFor('CANCELLED')
    expect(steps[0].state).toBe('done')
    expect(steps[1].state).toBe('pending')
    expect(steps[2].state).toBe('pending')
    expect(steps[3].state).toBe('pending')
  })

  it('has 4 steps with correct labels', () => {
    const steps = stepsFor('FUNDED')
    expect(steps).toHaveLength(4)
    expect(steps[0].label).toBe('Order created')
    expect(steps[1].label).toBe('Merchant locks USDC')
    expect(steps[2].label).toBe('Pay the merchant')
    expect(steps[3].label).toBe('USDC released to you')
  })
})

describe('isTerminal', () => {
  it('returns true for terminal statuses', () => {
    expect(isTerminal('RELEASED')).toBe(true)
    expect(isTerminal('CANCELLED')).toBe(true)
    expect(isTerminal('EXPIRED')).toBe(true)
    expect(isTerminal('REFUNDED')).toBe(true)
    expect(isTerminal('DISPUTED')).toBe(true)
  })

  it('returns false for non-terminal statuses', () => {
    expect(isTerminal('FUNDED')).toBe(false)
    expect(isTerminal('CREATED')).toBe(false)
    expect(isTerminal('FIAT_PAID')).toBe(false)
  })
})

describe('OrderStatus component', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      configurable: true,
    })
    mockCancelOrder.mockReset()
  })

  it('shows payment_instructions when present (FUNDED)', async () => {
    const order = { ...BASE_ORDER, id: 'ord-c1', payment_instructions: 'BCA 1234567890' }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c1" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('BCA 1234567890')).toBeTruthy()
    })
  })

  it('does NOT show payment_instructions card when field is absent', async () => {
    const order = { ...BASE_ORDER, id: 'ord-c2' }
    delete (order as Partial<typeof order>).payment_instructions
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c2" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0)
    })

    expect(screen.queryByText('BCA 1234567890')).toBeNull()
  })

  it('shows "ive-paid-slot" only when status is FUNDED', async () => {
    const order = { ...BASE_ORDER, id: 'ord-c3', status: 'FUNDED' as const }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c3" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('ive-paid-slot')).toBeTruthy()
    })
  })

  it('does NOT show "ive-paid-slot" when status is RELEASED', async () => {
    const order = { ...BASE_ORDER, id: 'ord-c4', status: 'RELEASED' as const, payment_instructions: undefined }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c4" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0)
    })

    expect(screen.queryByTestId('ive-paid-slot')).toBeNull()
  })

  it('shows USDC amount and fiat amount in summary card', async () => {
    const order = { ...BASE_ORDER, id: 'ord-c5', payment_instructions: undefined }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c5" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/100\.00/)).toBeTruthy()
    })

    expect(screen.getByText(/1\.600\.000/)).toBeTruthy()
  })

  it('shows the EXACT third-party-transfer warning for TOP_UP+FUNDED', async () => {
    const order: Order = { ...BASE_ORDER, id: 'ord-c6', status: 'FUNDED' }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c6" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(
        screen.getByText(
          'Pay from a bank account in your own name — third-party transfers are rejected and auto-refunded.',
        ),
      ).toBeTruthy()
    })
  })

  it('lpPaysFiat+FIAT_PAID: shows the payout-marked banner, confirm-release wrapper, and open-dispute', async () => {
    const order: Order = {
      ...BASE_ORDER,
      id: 'ord-c7',
      flow: 'WITHDRAW',
      status: 'FIAT_PAID',
    }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c7" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('The provider marked your payout as paid.')).toBeTruthy()
    })
    expect(screen.getByTestId('confirm-release')).toBeTruthy()
    expect(within(screen.getByTestId('confirm-release')).getByRole('button')).toBeTruthy()
    expect(screen.getByTestId('open-dispute')).toBeTruthy()
  })

  it('RELEASED (TOP_UP): shows the flow-aware Done panel, hides all action CTAs, Done → /orders', async () => {
    const order: Order = { ...BASE_ORDER, id: 'ord-c8', status: 'RELEASED' }
    mockGetOrder.mockResolvedValue(order)
    mockPush.mockClear()

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c8" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/USDC delivered/)).toBeTruthy()
    })
    expect(screen.queryByTestId('ive-paid-slot')).toBeNull()
    expect(screen.queryByTestId('lock-usdc')).toBeNull()
    expect(screen.queryByTestId('confirm-release')).toBeNull()

    const doneBtn = screen.getByRole('button', { name: /done/i })
    doneBtn.click()
    expect(mockPush).toHaveBeenCalledWith('/orders')
  })

  it('RELEASED (WITHDRAW): Done panel title is flow-aware ("Payment complete")', async () => {
    const order: Order = { ...BASE_ORDER, id: 'ord-c9', flow: 'WITHDRAW', status: 'RELEASED' }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c9" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Payment complete')).toBeTruthy()
    })
    expect(screen.queryByText(/USDC delivered/)).toBeNull()
  })

  it('REFUNDED: shows the amber refunded panel + Done → /orders', async () => {
    const order: Order = { ...BASE_ORDER, id: 'ord-c10', status: 'REFUNDED' }
    mockGetOrder.mockResolvedValue(order)
    mockPush.mockClear()

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c10" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Refunded — escrow returned')).toBeTruthy()
    })
    const doneBtn = screen.getByRole('button', { name: /done/i })
    doneBtn.click()
    expect(mockPush).toHaveBeenCalledWith('/orders')
  })

  it('DISPUTED: shows the danger panel with a short case id derived from the order id', async () => {
    const order: Order = { ...BASE_ORDER, id: 'ord-c11-abcdef', status: 'DISPUTED' }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c11-abcdef" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Dispute open — under review')).toBeTruthy()
    })

    expect(screen.getByText(/Case #/)).toBeTruthy()
  })

  it('EXPIRED: shows a neutral terminal panel (distinct from the status pill)', async () => {
    const order: Order = { ...BASE_ORDER, id: 'ord-c12', status: 'EXPIRED' }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c12" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('terminal-panel')).toBeTruthy()
    })
    expect(within(screen.getByTestId('terminal-panel')).getByText(/no funds were moved/i)).toBeTruthy()
    expect(screen.queryByTestId('ive-paid-slot')).toBeNull()
    expect(screen.queryByTestId('lock-usdc')).toBeNull()
  })

  it('CANCELLED: shows a neutral terminal panel (distinct from the status pill)', async () => {
    const order: Order = { ...BASE_ORDER, id: 'ord-c13', status: 'CANCELLED' }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-c13" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('terminal-panel')).toBeTruthy()
    })
    expect(within(screen.getByTestId('terminal-panel')).getByText(/no funds were moved/i)).toBeTruthy()
  })

  it('TOP_UP+FUNDED: shows a copy-on-tap ref chip when order.ref is present', async () => {
    const order: Order = {
      ...BASE_ORDER,
      id: 'ord-ref1',
      status: 'FUNDED',
      payment_instructions: 'BCA 1234567890',
      ref: 'LP-7X3M',
    }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-ref1" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('LP-7X3M')).toBeTruthy()
    })

    fireEvent.click(screen.getByTestId('transfer-ref'))
    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('LP-7X3M')
    })
  })

  it('TOP_UP+FUNDED: does NOT show the ref chip when order.ref is absent', async () => {
    const order: Order = {
      ...BASE_ORDER,
      id: 'ord-ref2',
      status: 'FUNDED',
      payment_instructions: 'BCA 1234567890',
    }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-ref2" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('BCA 1234567890')).toBeTruthy()
    })
    expect(screen.queryByTestId('transfer-ref')).toBeNull()
  })

  it('FIAT_PAID (TOP_UP): "Open dispute" opens the dispute form (reason chips) instead of signing immediately', async () => {
    const order: Order = { ...BASE_ORDER, id: 'ord-df1', status: 'FIAT_PAID' }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-df1" />
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByTestId('open-dispute')).toBeTruthy())
    expect(screen.queryByText('What went wrong?')).toBeNull()

    fireEvent.click(screen.getByTestId('open-dispute'))

    expect(screen.getByText('What went wrong?')).toBeTruthy()

    expect(screen.getByTestId('dispute-reason-USDC_NOT_RELEASED')).toBeTruthy()
  })

  it('FIAT_PAID (WITHDRAW): "Open dispute" opens the dispute form with fiat-payer reason chips', async () => {
    const order: Order = { ...BASE_ORDER, id: 'ord-df2', flow: 'WITHDRAW', status: 'FIAT_PAID' }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-df2" />
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByTestId('open-dispute')).toBeTruthy())
    fireEvent.click(screen.getByTestId('open-dispute'))

    expect(screen.getByText('What went wrong?')).toBeTruthy()
    expect(screen.getByTestId('dispute-reason-PAYMENT_NOT_RECEIVED')).toBeTruthy()
  })

  it('RELEASED: shows the post-settle dispute link + countdown when post_settle_dispute_until is present and future', async () => {
    const order: Order = {
      ...BASE_ORDER,
      id: 'ord-ps1',
      status: 'RELEASED',
      post_settle_dispute_until: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-ps1" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Something wrong? Open a dispute')).toBeTruthy()
    })
    expect(screen.getByTestId('open-dispute')).toBeTruthy()

    fireEvent.click(screen.getByTestId('open-dispute'))
    expect(screen.getByText('What went wrong?')).toBeTruthy()
  })

  it('RELEASED: hides the post-settle dispute link when post_settle_dispute_until is absent', async () => {
    const order: Order = { ...BASE_ORDER, id: 'ord-ps2', status: 'RELEASED' }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-ps2" />
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByText(/USDC delivered/)).toBeTruthy())
    expect(screen.queryByText('Something wrong? Open a dispute')).toBeNull()
    expect(screen.queryByTestId('open-dispute')).toBeNull()
  })

  it('RELEASED: hides the post-settle dispute link when the deadline has already lapsed', async () => {
    const order: Order = {
      ...BASE_ORDER,
      id: 'ord-ps3',
      status: 'RELEASED',
      post_settle_dispute_until: new Date(Date.now() - 1000).toISOString(),
    }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-ps3" />
      </TestProviders>,
    )

    await waitFor(() => expect(screen.getByText(/USDC delivered/)).toBeTruthy())
    expect(screen.queryByText('Something wrong? Open a dispute')).toBeNull()
  })

  it('REFUNDED: shows the post-settle dispute link when post_settle_dispute_until is present and future', async () => {
    const order: Order = {
      ...BASE_ORDER,
      id: 'ord-ps4',
      status: 'REFUNDED',
      post_settle_dispute_until: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    }
    mockGetOrder.mockResolvedValue(order)

    render(
      <TestProviders>
        <OrderStatusComponent id="ord-ps4" />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText('Something wrong? Open a dispute')).toBeTruthy()
    })
  })

})
