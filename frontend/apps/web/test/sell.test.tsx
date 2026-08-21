import * as React from 'react'
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TestProviders } from './helpers'
import { queryClient } from '@/app/providers'
import { USDC_ISSUER } from '@/lib/usdcAsset'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))

const pushMock = vi.hoisted(() => vi.fn())
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: pushMock, back: vi.fn() }) }))

const mockCreateQuote = vi.hoisted(() => vi.fn())
const mockCreateOrder = vi.hoisted(() => vi.fn())

const mockGetMyProfile = vi.hoisted(() => vi.fn(async () => undefined as unknown))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    createQuote: mockCreateQuote,
    createOrder: mockCreateOrder,
    getMyProfile: mockGetMyProfile,
  }
})

const { SellForm } = await import('@/components/SellForm')

describe('SellForm (WITHDRAW)', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    mockCreateQuote.mockResolvedValue({
      quote_id: 'q-sell',
      fiat_amount: '3652000',
      rate: '18260',
      platform_fee_bps: 30,
      lp_fee_bps: 120,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    })
    mockCreateOrder.mockResolvedValue({ order: { id: 'ord-sell', status: 'MATCHED' } })
  })

  it('quotes a WITHDRAW/BANK price for the typed USDC amount and shows the IDR received', async () => {
    render(
      <TestProviders>
        <SellForm />
      </TestProviders>,
    )
    fireEvent.change(screen.getByLabelText(/You sell/i), { target: { value: '20' } })

    await waitFor(() => {
      expect(mockCreateQuote).toHaveBeenCalledWith(expect.anything(), {
        flow: 'WITHDRAW',
        rail: 'BANK',
        usdcAmount: '200000000',
      })
      expect(screen.getByText(/Rp\s?3\.652\.000/)).toBeTruthy()
    })
  })

  it('shows only the total — no itemized fee line — while the net IDR still renders', async () => {
    render(
      <TestProviders>
        <SellForm />
      </TestProviders>,
    )
    fireEvent.change(screen.getByLabelText(/You sell/i), { target: { value: '20' } })

    await waitFor(() => {
      expect(screen.getByTestId('quote-net').textContent).toBe('Rp 3.652.000')
    })

    expect(screen.queryByText(/fee/i)).toBeNull()
  })

  it('CTA opens the review sheet and does NOT create the order until confirmed; confirm creates it with the same quote id', async () => {
    render(
      <TestProviders>
        <SellForm />
      </TestProviders>,
    )
    fireEvent.change(screen.getByLabelText(/You sell/i), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText(/bank account/i), {
      target: { value: 'BCA 123 a/n Me' },
    })

    await waitFor(() => expect(screen.getByText(/Rp\s?3\.652\.000/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Lock USDC & sell/i }))

    await waitFor(() => expect(screen.getByText('Review order')).toBeTruthy())
    expect(mockCreateOrder).not.toHaveBeenCalled()
    expect(pushMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: /confirm — sign/i }))

    await waitFor(() => {
      expect(mockCreateOrder).toHaveBeenCalledWith(expect.anything(), {
        quoteId: 'q-sell',
        userPaymentMethod: 'BCA 123 a/n Me',
      })
      expect(pushMock).toHaveBeenCalledWith('/orders/ord-sell')
    })
  })

  it('rejects continuing without bank details', async () => {
    render(
      <TestProviders>
        <SellForm />
      </TestProviders>,
    )
    fireEvent.change(screen.getByLabelText(/You sell/i), { target: { value: '20' } })
    await waitFor(() => expect(screen.getByText(/Rp\s?3\.652\.000/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Lock USDC & sell/i }))
    await waitFor(() => expect(screen.getByText(/bank account details/i)).toBeTruthy())
    expect(screen.queryByText('Review order')).toBeNull()
    expect(mockCreateOrder).not.toHaveBeenCalled()
  })
})

describe('SellForm — balance and exceeds-balance', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    mockCreateQuote.mockResolvedValue({
      quote_id: 'q-sell2',
      fiat_amount: '3652000',
      rate: '18260',
      platform_fee_bps: 30,
      lp_fee_bps: 120,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    })
  })

  it('shows "—" for balance when no wallet is connected (no exceeds-balance check)', async () => {
    render(
      <TestProviders>
        <SellForm />
      </TestProviders>,
    )
    expect(screen.getByText(/Balance/)).toBeTruthy()
    expect(screen.queryByText(/exceeds balance/i)).toBeNull()
  })
})

describe('SellForm — quote expires while the review sheet is open', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    mockCreateOrder.mockResolvedValue({ order: { id: 'ord-sell', status: 'MATCHED' } })
  })

  it('closes the sheet', async () => {
    mockCreateQuote.mockImplementation(async () => ({
      quote_id: 'q-short',
      fiat_amount: '3652000',
      rate: '18260',
      platform_fee_bps: 30,
      lp_fee_bps: 120,
      expires_at: new Date(Date.now() + 1500).toISOString(),
    }))

    render(
      <TestProviders>
        <SellForm />
      </TestProviders>,
    )
    fireEvent.change(screen.getByLabelText(/You sell/i), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText(/bank account/i), {
      target: { value: 'BCA 123 a/n Me' },
    })
    await waitFor(() => expect(screen.getByText(/Rp\s?3\.652\.000/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Lock USDC & sell/i }))
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

describe('SellForm — the review sheet is immune to a background quote refetch', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    mockCreateOrder.mockResolvedValue({ order: { id: 'ord-sell', status: 'MATCHED' } })
  })

  it('keeps showing the ORIGINAL quote and submits the ORIGINAL quote_id even after the live quote query refetches a new one underneath it', async () => {
    let calls = 0
    mockCreateQuote.mockImplementation(async () => {
      calls += 1
      return calls === 1
        ? {
            quote_id: 'q-first',
            fiat_amount: '3652000',
            rate: '18260',
            platform_fee_bps: 30,
            lp_fee_bps: 120,
            expires_at: new Date(Date.now() + 120000).toISOString(),
          }
        : {
            quote_id: 'q-second',
            fiat_amount: '3900000',
            rate: '19500',
            platform_fee_bps: 40,
            lp_fee_bps: 150,
            expires_at: new Date(Date.now() + 120000).toISOString(),
          }
    })

    render(
      <TestProviders>
        <SellForm />
      </TestProviders>,
    )
    fireEvent.change(screen.getByLabelText(/You sell/i), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText(/bank account/i), {
      target: { value: 'BCA 123 a/n Me' },
    })
    await waitFor(() => expect(screen.getByText(/Rp\s?3\.652\.000/)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: /Lock USDC & sell/i }))
    await waitFor(() => expect(screen.getByText('Review order')).toBeTruthy())

    const sheet = () =>
      within(screen.getByText('Review order').closest('div.flex.flex-col') as HTMLElement)
    expect(sheet().getByText(/Rp\s?3\.652\.000/)).toBeTruthy()

    await act(async () => {
      await queryClient.refetchQueries({ queryKey: ['sellQuote'] })
    })

    await waitFor(() => expect(calls).toBeGreaterThanOrEqual(2))

    await waitFor(() => expect(screen.getByText(/Rp\s?3\.900\.000/)).toBeTruthy())

    expect(screen.getByText('Review order')).toBeTruthy()
    expect(sheet().getByText(/Rp\s?3\.652\.000/)).toBeTruthy()
    expect(sheet().queryByText(/Rp\s?3\.900\.000/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /confirm — sign/i }))
    await waitFor(() => {
      expect(mockCreateOrder).toHaveBeenCalledWith(expect.anything(), {
        quoteId: 'q-first',
        userPaymentMethod: 'BCA 123 a/n Me',
      })
    })
    expect(mockCreateOrder).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ quoteId: 'q-second' }),
    )
  })
})

describe('SellForm — exceeds-balance BigInt logic (authenticated, positive path)', () => {
  const ADDR = 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X'
  const ISSUER = USDC_ISSUER
  const realFetch = global.fetch

  function mockHorizonBalance(balance: string) {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        balances: [{ asset_code: 'TUSDC', asset_issuer: ISSUER, balance }],
      }),
    }) as any
  }

  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()

    sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
    sessionStorage.setItem('lp_addr', ADDR)
    mockCreateQuote.mockResolvedValue({
      quote_id: 'q-sell-bal',
      fiat_amount: '3652000',
      rate: '18260',
      platform_fee_bps: 30,
      lp_fee_bps: 120,
      expires_at: new Date(Date.now() + 60000).toISOString(),
    })
    mockCreateOrder.mockResolvedValue({ order: { id: 'ord-sell', status: 'MATCHED' } })
  })

  afterEach(() => {
    sessionStorage.clear()
    global.fetch = realFetch
  })

  it('amount exactly equal to the balance is NOT flagged and Continue is allowed', async () => {
    mockHorizonBalance('20.0000000')
    render(
      <TestProviders>
        <SellForm />
      </TestProviders>,
    )
    await waitFor(() => expect(screen.getByText(/20\.00/)).toBeTruthy())

    fireEvent.change(screen.getByLabelText(/You sell/i), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText(/bank account/i), {
      target: { value: 'BCA 123 a/n Me' },
    })
    await waitFor(() => expect(screen.getByText(/Rp\s?3\.652\.000/)).toBeTruthy())

    expect(screen.queryByText(/exceeds balance/i)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /Lock USDC & sell/i }))
    await waitFor(() => expect(screen.getByText('Review order')).toBeTruthy())
    expect(mockCreateOrder).not.toHaveBeenCalled()
  })

  it('amount 1 base-unit over the balance IS flagged "· exceeds balance" and Continue is blocked', async () => {
    mockHorizonBalance('20.0000000')
    render(
      <TestProviders>
        <SellForm />
      </TestProviders>,
    )
    await waitFor(() => expect(screen.getByText(/20\.00/)).toBeTruthy())

    fireEvent.change(screen.getByLabelText(/You sell/i), { target: { value: '20.0000001' } })
    fireEvent.change(screen.getByLabelText(/bank account/i), {
      target: { value: 'BCA 123 a/n Me' },
    })

    await waitFor(() => expect(screen.getByText(/exceeds balance/i)).toBeTruthy())

    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Lock USDC & sell/i })).toBeEnabled(),
    )

    fireEvent.click(screen.getByRole('button', { name: /Lock USDC & sell/i }))
    expect(screen.getByText(/Amount exceeds your balance/i)).toBeTruthy()
    expect(screen.queryByText('Review order')).toBeNull()
    expect(mockCreateOrder).not.toHaveBeenCalled()
  })

  it('a malformed Horizon balance string does not crash the form and renders the unknown-balance state', async () => {
    mockHorizonBalance('abc')
    expect(() =>
      render(
        <TestProviders>
          <SellForm />
        </TestProviders>,
      ),
    ).not.toThrow()

    await waitFor(() => expect(screen.getByText(/—\s*USDC/)).toBeTruthy())
    expect(screen.queryByText(/exceeds balance/i)).toBeNull()

    fireEvent.change(screen.getByLabelText(/You sell/i), { target: { value: '20' } })
    fireEvent.change(screen.getByLabelText(/bank account/i), {
      target: { value: 'BCA 123 a/n Me' },
    })
    await waitFor(() => expect(screen.getByText(/Rp\s?3\.652\.000/)).toBeTruthy())

    expect(screen.queryByText(/exceeds balance/i)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Lock USDC & sell/i }))
    await waitFor(() => expect(screen.getByText('Review order')).toBeTruthy())
    expect(mockCreateOrder).not.toHaveBeenCalled()
  })

  it('an input with more than 7 decimal places does not throw and is not (falsely) flagged as exceeding balance', async () => {
    mockHorizonBalance('20.0000000')
    render(
      <TestProviders>
        <SellForm />
      </TestProviders>,
    )
    await waitFor(() => expect(screen.getByText(/20\.00/)).toBeTruthy())

    expect(() =>
      fireEvent.change(screen.getByLabelText(/You sell/i), {
        target: { value: '1.123456789' },
      }),
    ).not.toThrow()

    expect(screen.queryByText(/exceeds balance/i)).toBeNull()

    const cta = screen.getByRole('button', { name: /Lock USDC & sell/i })
    expect(cta).toBeDisabled()
    fireEvent.click(cta)
    expect(screen.queryByText('Review order')).toBeNull()
    expect(mockCreateOrder).not.toHaveBeenCalled()
  })
})

describe('SellForm — daily-limit row', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  it('is hidden when the profile is absent (default mock resolves undefined)', async () => {
    render(
      <TestProviders>
        <SellForm />
      </TestProviders>,
    )
    await waitFor(() => expect(mockGetMyProfile).toHaveBeenCalled())
    expect(screen.queryByTestId('daily-limit-row')).toBeNull()
  })

  it('shows the remaining/limit/tier once the profile resolves — informational, not a fee', async () => {
    mockGetMyProfile.mockResolvedValue({
      tier: 'TRUSTED',
      completed_trades: 25,
      disputes_lost: 0,
      completion_rate: 1,
      daily_limit_usdc: 600,
      daily_used_usdc: 100,
      daily_remaining_usdc: 500,
    })
    render(
      <TestProviders>
        <SellForm />
      </TestProviders>,
    )
    const row = await screen.findByTestId('daily-limit-row')
    expect(row).toHaveTextContent('500.00')
    expect(row).toHaveTextContent('600.00')
    expect(row).toHaveTextContent('Trusted')
    expect(row.textContent).not.toMatch(/fee/i)
  })
})
