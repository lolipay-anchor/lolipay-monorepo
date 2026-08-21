import * as React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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

const push = vi.hoisted(() => vi.fn())
const mockCreateOrder = vi.hoisted(() =>
  vi.fn(async () => ({ order: { id: 'o1' } })),
)

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push }),
}))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getRate: vi.fn(async () => ({
      asset: 'USDC',
      fiat: 'IDR',
      rate: '16000',
      ts: 't',
    })),
    createQuote: vi.fn(async () => ({
      quote_id: 'q1',
      fiat_amount: '1624000',
      rate: '16000',
      platform_fee_bps: 30,
      lp_fee_bps: 120,
      expires_at: new Date(Date.now() + 120_000).toISOString(),
    })),
    createOrder: mockCreateOrder,
  }
})

const { BuyForm } = await import('@/components/BuyForm')

async function driveValidQuote() {
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '1624000' } })
  await waitFor(() => expect(screen.getByText(/1 USDC = Rp/)).toBeTruthy(), {
    timeout: 2000,
  })
}

describe('create-order', () => {
  beforeEach(() => {
    queryClient.clear()
    push.mockClear()
    mockCreateOrder.mockClear()
    mockCreateOrder.mockResolvedValue({ order: { id: 'o1' } })
  })

  it('navigates to /orders/:id when the review sheet is confirmed', async () => {
    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    await driveValidQuote()

    const btn = screen.getByRole('button', { name: /continue to pay/i })
    fireEvent.click(btn)

    await waitFor(() => expect(screen.getByText('Review order')).toBeTruthy())
    expect(mockCreateOrder).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /confirm — sign/i }))

    await waitFor(() => {
      expect(mockCreateOrder).toHaveBeenCalledWith(expect.anything(), { quoteId: 'q1' })
      expect(push).toHaveBeenCalledWith('/orders/o1')
    })
  })

  it('shows error and does NOT navigate when createOrder rejects (409)', async () => {
    mockCreateOrder.mockRejectedValueOnce(new Error('409: quote expired or used'))

    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    await driveValidQuote()

    const btn = screen.getByRole('button', { name: /continue to pay/i })
    fireEvent.click(btn)
    await waitFor(() => expect(screen.getByText('Review order')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: /confirm — sign/i }))

    await waitFor(() => {
      expect(screen.getByText(/409: quote expired or used/i)).toBeTruthy()
    })

    expect(push).not.toHaveBeenCalled()
  })
})
