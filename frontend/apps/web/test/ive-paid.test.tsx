import * as React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders } from './helpers'

vi.mock('@/lib/wallet-kit', () => ({
  getDefaultKit: vi.fn(() => ({})),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
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

const mockGetMarkPaidTx = vi.hoisted(() => vi.fn())

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getMarkPaidTx: mockGetMarkPaidTx,
  }
})

const { IvePaidSheet } = await import('@/components/IvePaidSheet')

const SAMPLE_ORDER = {
  id: 'ord-mp1',
  trade_id: 'tr-1',
  user_address: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X',
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
  payment_instructions: 'BCA 1234567890 a.n. Merchant',
}

describe('IvePaidSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders warning text, amount, and payment_instructions', async () => {
    render(
      <TestProviders>
        <IvePaidSheet
          order={SAMPLE_ORDER}
          open={true}
          onClose={vi.fn()}
          onConfirmed={vi.fn()}
        />
      </TestProviders>,
    )

    expect(
      screen.getByText(/Only confirm AFTER your transfer is actually completed/i),
    ).toBeTruthy()

    expect(screen.getAllByText(/1\.600\.000/).length).toBeGreaterThanOrEqual(1)

    expect(screen.getByText('BCA 1234567890 a.n. Merchant')).toBeTruthy()
  })

  it('confirm button is DISABLED until the checkbox is checked', async () => {
    render(
      <TestProviders>
        <IvePaidSheet
          order={SAMPLE_ORDER}
          open={true}
          onClose={vi.fn()}
          onConfirmed={vi.fn()}
        />
      </TestProviders>,
    )

    const btn = screen.getByRole('button', { name: /Yes, I've paid/i })
    expect(btn).toBeDisabled()

    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)

    expect(btn).not.toBeDisabled()
  })

  it('unchecking the checkbox disables the confirm button again', async () => {
    render(
      <TestProviders>
        <IvePaidSheet
          order={SAMPLE_ORDER}
          open={true}
          onClose={vi.fn()}
          onConfirmed={vi.fn()}
        />
      </TestProviders>,
    )

    const checkbox = screen.getByRole('checkbox')
    const btn = screen.getByRole('button', { name: /Yes, I've paid/i })

    fireEvent.click(checkbox)
    expect(btn).not.toBeDisabled()

    fireEvent.click(checkbox)
    expect(btn).toBeDisabled()
  })

  it('calls onConfirmed after a successful mocked submit', async () => {
    const onConfirmed = vi.fn()

    mockGetMarkPaidTx.mockResolvedValue({
      xdr: 'AAAA==',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })

    const mockSubmitFn = vi.fn(async () => ({ status: 'PENDING' }))

    render(
      <TestProviders>
        <IvePaidSheet
          order={SAMPLE_ORDER}
          open={true}
          onClose={vi.fn()}
          onConfirmed={onConfirmed}
          submitFn={mockSubmitFn}
        />
      </TestProviders>,
    )

    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)

    const btn = screen.getByRole('button', { name: /Yes, I've paid/i })
    fireEvent.click(btn)

    await waitFor(() => {
      expect(onConfirmed).toHaveBeenCalledTimes(1)
    })

    expect(mockSubmitFn).toHaveBeenCalledWith(
      'SIGNED_XDR',
      'Test SDF Network ; September 2015',
    )
  })

  it('shows error when getMarkPaidTx fails', async () => {
    mockGetMarkPaidTx.mockRejectedValue(new Error('Network error'))

    render(
      <TestProviders>
        <IvePaidSheet
          order={SAMPLE_ORDER}
          open={true}
          onClose={vi.fn()}
          onConfirmed={vi.fn()}
        />
      </TestProviders>,
    )

    const checkbox = screen.getByRole('checkbox')
    fireEvent.click(checkbox)

    const btn = screen.getByRole('button', { name: /Yes, I've paid/i })
    fireEvent.click(btn)

    await waitFor(() => {
      expect(screen.getByText(/Network error/i)).toBeTruthy()
    })
  })

  it('does not render when open=false', () => {
    render(
      <TestProviders>
        <IvePaidSheet
          order={SAMPLE_ORDER}
          open={false}
          onClose={vi.fn()}
          onConfirmed={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.queryByText(/Did you already pay/i)).toBeNull()
  })
})
