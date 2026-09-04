import * as React from 'react'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TestProviders } from './helpers'
import { queryClient } from '@/app/providers'

vi.mock('@/lib/wallet-kit', () => ({
  getDefaultKit: vi.fn(() => ({})),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
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

const mockCreateOrder = vi.hoisted(() => vi.fn(async () => ({ order: { id: 'o1' } })))

const mockGetMyProfile = vi.hoisted(() => vi.fn(async () => undefined as unknown))

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
      expires_at: new Date(Date.now() + 120000).toISOString(),
    })),
    createOrder: mockCreateOrder,
    getMyProfile: mockGetMyProfile,
  }
})

const { BuyForm } = await import('@/components/BuyForm')
const apiClient = await import('@lolipay/api-client')

describe('BuyForm', () => {
  beforeEach(() => {
    queryClient.clear()
    mockCreateOrder.mockClear()
    mockGetMyProfile.mockReset()
    mockGetMyProfile.mockResolvedValue(undefined as unknown as never)
  })

  it('shows net USDC and all-in rate after typing an IDR amount', async () => {
    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '1624000' } })

    await waitFor(
      () => {
        expect(screen.getByText(/1 USDC = Rp/)).toBeTruthy()
      },
      { timeout: 2000 },
    )

    expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0)
  })

  it('refuses an amount with a comma or a fraction, says why beside the field, and asks for no quote', async () => {
    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '1624000' } })
    await waitFor(() => expect(screen.getByText(/1 USDC = Rp/)).toBeTruthy(), { timeout: 2000 })

    fireEvent.change(input, { target: { value: '1624000,50' } })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/plain digits/i)
    })
    await waitFor(() => expect(screen.queryByText(/1 USDC = Rp/)).toBeNull(), { timeout: 2000 })
    expect(input.getAttribute('aria-describedby')).toBe(screen.getByRole('alert').id)
  })

  it('shows only the total — no itemized fee line — while the net still renders', async () => {
    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '1624000' } })

    await waitFor(
      () => {
        expect(screen.getByTestId('quote-net').textContent).toBe('99.97 USDC')
      },
      { timeout: 2000 },
    )

    expect(screen.queryByText(/fee/i)).toBeNull()
  })

  it('quick-amount chips pre-fill the input', async () => {
    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    fireEvent.click(screen.getByText('Rp 250.000'))

    const input = screen.getByRole('textbox') as HTMLInputElement
    expect(input.value).toBe('250000')
  })

  it('CTA opens the review sheet with the locked quote and does NOT create the order until confirmed', async () => {
    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '1624000' } })
    await waitFor(() => expect(screen.getByText(/1 USDC = Rp/)).toBeTruthy(), { timeout: 2000 })

    fireEvent.click(screen.getByRole('button', { name: /continue to pay/i }))

    expect(screen.getByText('Review order')).toBeTruthy()
    expect(screen.getAllByText(/Rp\s?1\.624\.000/).length).toBeGreaterThan(0)
    expect(mockCreateOrder).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /confirm — sign/i }))
    await waitFor(() => {
      expect(mockCreateOrder).toHaveBeenCalledWith(expect.anything(), { quoteId: 'q1' })
    })
  })

  it('Back closes the sheet without creating the order', async () => {
    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '1624000' } })
    await waitFor(() => expect(screen.getByText(/1 USDC = Rp/)).toBeTruthy(), { timeout: 2000 })

    fireEvent.click(screen.getByRole('button', { name: /continue to pay/i }))
    expect(screen.getByText('Review order')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(screen.queryByText('Review order')).toBeNull()
    expect(mockCreateOrder).not.toHaveBeenCalled()
  })
})

describe('BuyForm — an unusable rate from the server', () => {
  beforeEach(() => {
    queryClient.clear()
    mockCreateOrder.mockClear()
    mockGetMyProfile.mockReset()
    mockGetMyProfile.mockResolvedValue(undefined as unknown as never)
  })

  afterEach(() => {
    vi.mocked(apiClient.getRate).mockImplementation(async () => ({ asset: 'USDC', fiat: 'IDR', rate: '16000', ts: 't' }) as never)
  })

  it('renders, asks for no quote and keeps Continue disabled when the rate is 0, instead of crashing on BigInt', async () => {
    vi.mocked(apiClient.getRate).mockImplementation(async () => ({ asset: 'USDC', fiat: 'IDR', rate: '0', ts: 't' }) as never)
    const quotesBefore = vi.mocked(apiClient.createQuote).mock.calls.length
    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '1624000' } })

    await new Promise((r) => setTimeout(r, 600))
    expect(screen.getByRole('textbox')).toBeTruthy()
    expect(vi.mocked(apiClient.createQuote).mock.calls.length).toBe(quotesBefore)
    expect((screen.getByRole('button', { name: /Continue to pay/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('BuyForm — quote expires while the review sheet is open', () => {
  beforeEach(() => {
    queryClient.clear()
    mockCreateOrder.mockClear()
  })

  it('closes the sheet (no stale quote gets confirmed)', async () => {
    const { createQuote } = await import('@lolipay/api-client')

    vi.mocked(createQuote).mockImplementation(async () => ({
      quote_id: 'q-short',
      usdc_amount: '3125000000',
      fiat_amount: '5030000',
      rate: '16000',
      platform_fee_bps: 30,
      lp_fee_bps: 120,
      expires_at: new Date(Date.now() + 1500).toISOString(),
    }))

    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '5000000' } })
    await waitFor(() => expect(screen.getByText(/1 USDC = Rp/)).toBeTruthy(), { timeout: 2000 })

    fireEvent.click(screen.getByRole('button', { name: /continue to pay/i }))
    expect(screen.getByText('Review order')).toBeTruthy()

    await waitFor(
      () => {
        expect(screen.queryByText('Review order')).toBeNull()
      },
      { timeout: 4000 },
    )
    expect(mockCreateOrder).not.toHaveBeenCalled()
  })
})

describe('BuyForm — the review sheet is immune to a background quote refetch', () => {
  beforeEach(() => {
    queryClient.clear()
    mockCreateOrder.mockClear()
  })

  it('keeps showing the ORIGINAL quote and submits the ORIGINAL quote_id even after the live quote query refetches a new one underneath it', async () => {
    const { createQuote } = await import('@lolipay/api-client')
    let calls = 0
    vi.mocked(createQuote).mockImplementation(async () => {
      calls += 1
      return calls === 1
        ? {
            quote_id: 'q-first',
            usdc_amount: '1015000000',
            fiat_amount: '1624000',
            rate: '16000',
            platform_fee_bps: 30,
            lp_fee_bps: 120,
            expires_at: new Date(Date.now() + 120000).toISOString(),
          }
        : {
            quote_id: 'q-second',
            usdc_amount: '990000000',
            fiat_amount: '1700000',
            rate: '17000',
            platform_fee_bps: 40,
            lp_fee_bps: 150,
            expires_at: new Date(Date.now() + 120000).toISOString(),
          }
    })

    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )

    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: '1624000' } })
    await waitFor(() => expect(screen.getByText(/1 USDC = Rp/)).toBeTruthy(), { timeout: 2000 })

    fireEvent.click(screen.getByRole('button', { name: /continue to pay/i }))
    expect(screen.getByText('Review order')).toBeTruthy()

    const sheet = () =>
      within(screen.getByText('Review order').closest('div.flex.flex-col') as HTMLElement)
    expect(sheet().getByText(/Rp\s?1\.624\.000/)).toBeTruthy()

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['quote'] })
    })

    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2))

    await waitFor(() => expect(screen.getByText(/Rp\s?1\.700\.000/)).toBeTruthy())

    expect(screen.getByText('Review order')).toBeTruthy()
    expect(sheet().getByText(/Rp\s?1\.624\.000/)).toBeTruthy()
    expect(sheet().queryByText(/Rp\s?1\.700\.000/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /confirm — sign/i }))
    await waitFor(() => {
      expect(mockCreateOrder).toHaveBeenCalledWith(expect.anything(), { quoteId: 'q-first' })
    })
    expect(mockCreateOrder).not.toHaveBeenCalledWith(expect.anything(), { quoteId: 'q-second' })
  })
})

describe('BuyForm — daily-limit row', () => {
  beforeEach(() => {
    queryClient.clear()
    mockCreateOrder.mockClear()
    mockGetMyProfile.mockReset()
  })

  it('is hidden while the profile is loading', () => {
    mockGetMyProfile.mockReturnValue(new Promise(() => {}))
    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )
    expect(screen.queryByTestId('daily-limit-row')).toBeNull()
  })

  it('is hidden when the profile is absent (fetch error)', async () => {
    mockGetMyProfile.mockRejectedValue(new Error('down'))
    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )
    await waitFor(() => expect(mockGetMyProfile).toHaveBeenCalled())
    expect(screen.queryByTestId('daily-limit-row')).toBeNull()
  })

  it('shows the remaining/limit/tier once the profile resolves — informational, not a fee', async () => {
    mockGetMyProfile.mockResolvedValue({
      tier: 'SILVER',
      completed_trades: 7,
      disputes_lost: 0,
      completion_rate: 1,
      daily_limit_usdc: 300,
      daily_used_usdc: 40,
      daily_remaining_usdc: 260,
    })
    render(
      <TestProviders>
        <BuyForm />
      </TestProviders>,
    )
    const row = await screen.findByTestId('daily-limit-row')
    expect(row).toHaveTextContent('260.00')
    expect(row).toHaveTextContent('300.00')
    expect(row).toHaveTextContent('Silver')
    expect(row.textContent).not.toMatch(/fee/i)
  })
})
