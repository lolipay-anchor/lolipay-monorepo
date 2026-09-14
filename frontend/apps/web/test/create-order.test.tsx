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
const apiClient = await import('@lolipay/api-client')

async function driveValidQuote() {
  const quotesBefore = vi.mocked(apiClient.createQuote).mock.calls.length
  const input = screen.getByRole('textbox')
  fireEvent.change(input, { target: { value: '1624000' } })
  await waitFor(
    () =>
      expect(vi.mocked(apiClient.createQuote).mock.calls.length).toBeGreaterThan(quotesBefore),
    { timeout: 2000 },
  )
  await waitFor(() => expect(screen.getByTestId('quote-net')).toBeTruthy())
  expect(screen.getByText(/1 USDC = Rp/)).toBeTruthy()
}

async function openReviewSheet() {
  const cta = screen.getByRole('button', { name: /continue to pay/i })
  await waitFor(() => expect(cta).toBeEnabled())
  fireEvent.click(cta)
  expect(screen.getByText('Review order')).toBeTruthy()
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

    await openReviewSheet()
    expect(mockCreateOrder).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /confirm — sign/i }))

    await waitFor(() => {
      expect(mockCreateOrder).toHaveBeenCalledWith(expect.anything(), { quoteId: 'q1' })
      expect(push).toHaveBeenCalledWith('/orders/o1')
    })
  })

  it('shows error and does NOT navigate when createOrder rejects (409)', async () => {
    mockCreateOrder.mockRejectedValueOnce(new Error('quote already used'))

    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    await driveValidQuote()

    await openReviewSheet()

    fireEvent.click(screen.getByRole('button', { name: /confirm — sign/i }))

    await waitFor(() => {
      expect(screen.getByTestId('order-refusal').textContent).toBe('That price expired. Get a new quote and try again.')
    })

    expect(push).not.toHaveBeenCalled()
  })

  it('closes the review sheet and tells a first-time user what the anchor requires when the order is refused for identity, instead of hiding the reason behind the sheet', async () => {
    mockCreateOrder.mockRejectedValueOnce(new Error('identity verification is required before a trade can be opened'))

    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    await driveValidQuote()
    await openReviewSheet()

    fireEvent.click(screen.getByRole('button', { name: /confirm — sign/i }))

    await waitFor(() => {
      expect(screen.queryByText('Review order')).toBeNull()
      expect(screen.getByTestId('order-refusal').textContent).toMatch(/verify your identity before your first trade/i)
    })
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(push).not.toHaveBeenCalled()

    await openReviewSheet()
    expect(screen.queryByTestId('order-refusal')).toBeNull()
  })

  it('offers only buying and selling, because bill payment was removed from the product', () => {
    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )
    expect(screen.getByRole('button', { name: 'Buy' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sell' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /pay bill/i })).toBeNull()
  })
})
