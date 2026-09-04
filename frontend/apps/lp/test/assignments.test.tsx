import * as React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'
import type { Order } from '@lolipay/api-client'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/assignments'),
  useRouter: vi.fn(() => ({ back: vi.fn() })),
}))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    authenticate: vi.fn(),
    getAssignments: vi.fn(),
    getCreateTradeTx: vi.fn(),
    getConfirmReleaseTx: vi.fn(),
    getMarkPaidTx: vi.fn(),
    getRaiseDisputeTx: vi.fn(),

    uploadProof: vi.fn(),
  }
})

const { AssignmentCard, ConfirmReleaseSheet } = await import('@/app/assignments/page')
const AssignmentsPage = (await import('@/app/assignments/page')).default
const apiClient = await import('@lolipay/api-client')

function makeOrder(overrides: Partial<Order> = {}): Order {
  return {
    id: 'order-1',
    trade_id: 'trade-abc',
    user_address: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6XTEST',
    lp_wallet: 'GBCTQ3PJVHQR7XKHSMXJHCWXBZBKLJZTEST',
    flow: 'TOP_UP',
    rail: 'BANK',
    usdc_amount: '1000000000',
    fiat_amount: '1500000',
    fiat_currency: 'IDR',
    rate_snapshot: '15000',
    platform_fee_bps: 50,
    lp_fee_bps: 50,
    status: 'MATCHED',
    pay_deadline: 0,
    confirm_deadline: 0,
    dispute_deadline: 0,
    expires_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  }
}

describe('AssignmentCard — Lock USDC (MATCHED)', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  it('renders order summary and Lock USDC button for MATCHED status', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'MATCHED' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByText(/Provide 100\.00 USDC/)).toBeTruthy()
    expect(screen.getByText(/You receive Rp 1.500.000 via BANK/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Lock USDC/i })).toBeTruthy()
    expect(screen.getByText(/MATCHED/)).toBeTruthy()
  })

  it('renders Lock USDC button for AWAITING_ONCHAIN status too', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'AWAITING_ONCHAIN' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByRole('button', { name: /Lock USDC/i })).toBeTruthy()
  })

  it('calls getCreateTradeTx → wallet.signTransaction → submitFn on click', async () => {
    vi.mocked(apiClient.getCreateTradeTx).mockResolvedValue({
      xdr: 'UNSIGNED_XDR',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
    const mockSubmit = vi.fn().mockResolvedValue({ status: 'PENDING' })
    const mockRefetch = vi.fn()

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'MATCHED' }) }}
          onRefetch={mockRefetch}
          submitFn={mockSubmit}
        />
      </TestProviders>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Lock USDC/i }))

    await waitFor(() => {
      expect(apiClient.getCreateTradeTx).toHaveBeenCalledWith(
        expect.anything(),
        'order-1',
      )

      expect(fakeKit.signTransaction).toHaveBeenCalledWith('UNSIGNED_XDR', {
        networkPassphrase: 'Test SDF Network ; September 2015',
      })

      expect(mockSubmit).toHaveBeenCalledWith(
        'SIGNED_XDR',
        'Test SDF Network ; September 2015',
      )

      expect(mockRefetch).toHaveBeenCalled()
    })
  })

  it('shows error alert when wallet rejects the lock', async () => {
    vi.mocked(apiClient.getCreateTradeTx).mockResolvedValue({
      xdr: 'XDR',
      networkPassphrase: 'np',
    })
    vi.mocked(fakeKit.signTransaction).mockRejectedValueOnce(
      new Error('User rejected transaction'),
    )

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'MATCHED' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Lock USDC/i }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(screen.getByText(/User rejected transaction/i)).toBeTruthy()
    })
  })

  it('shows "Waiting for buyer\'s payment" with no action for FUNDED', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'FUNDED' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByText(/Waiting for buyer's payment/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Lock USDC/i })).toBeNull()
  })
})

describe('AssignmentCard — Confirm receipt & release (FIAT_PAID)', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  it('renders Confirm receipt & release button for FIAT_PAID', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'FIAT_PAID' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByRole('button', { name: /Confirm receipt & release/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Lock USDC/i })).toBeNull()
    expect((screen.getByTestId('lp-open-dispute') as HTMLButtonElement).type).toBe('button')
  })

  it('opens the safeguard sheet with warning when button is clicked', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'FIAT_PAID' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Confirm receipt & release/i }))

    await waitFor(() => {
      expect(screen.getByText(/Only release AFTER/i)).toBeTruthy()

      const checkbox = screen.getByRole('checkbox')
      expect(checkbox).toBeTruthy()
    })
  })

  it('Release USDC button is disabled until checkbox is checked', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'FIAT_PAID' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Confirm receipt & release/i }))

    await waitFor(() => screen.getByRole('checkbox'))

    const releaseBtn = screen.getByRole('button', { name: /Release USDC/i })

    expect(releaseBtn.hasAttribute('disabled')).toBe(true)

    fireEvent.click(screen.getByRole('checkbox'))
    expect(releaseBtn.hasAttribute('disabled')).toBe(false)
  })

  it('calls getConfirmReleaseTx → sign → submitFn after checkbox + confirm', async () => {
    vi.mocked(apiClient.getConfirmReleaseTx).mockResolvedValue({
      xdr: 'CONFIRM_XDR',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
    const mockSubmit = vi.fn().mockResolvedValue({ status: 'PENDING' })
    const mockRefetch = vi.fn()

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'FIAT_PAID' }) }}
          onRefetch={mockRefetch}
          submitFn={mockSubmit}
        />
      </TestProviders>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Confirm receipt & release/i }))
    await waitFor(() => screen.getByRole('checkbox'))

    fireEvent.click(screen.getByRole('checkbox'))

    fireEvent.click(screen.getByRole('button', { name: /Release USDC/i }))

    await waitFor(() => {
      expect(apiClient.getConfirmReleaseTx).toHaveBeenCalledWith(
        expect.anything(),
        'order-1',
      )

      expect(fakeKit.signTransaction).toHaveBeenCalledWith('CONFIRM_XDR', {
        networkPassphrase: 'Test SDF Network ; September 2015',
      })

      expect(mockSubmit).toHaveBeenCalledWith(
        'SIGNED_XDR',
        'Test SDF Network ; September 2015',
      )

      expect(mockRefetch).toHaveBeenCalled()
    })
  })

  it('cannot be dismissed via Escape while the release is in flight', async () => {
    vi.mocked(apiClient.getConfirmReleaseTx).mockResolvedValue({
      xdr: 'CONFIRM_XDR',
      networkPassphrase: 'Test SDF Network ; September 2015',
    })
    let resolveSubmit!: (v: unknown) => void
    const mockSubmit = vi.fn(
      () => new Promise((resolve) => { resolveSubmit = resolve }),
    )

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'FIAT_PAID' }) }}
          onRefetch={vi.fn()}
          submitFn={mockSubmit}
        />
      </TestProviders>,
    )

    fireEvent.click(screen.getByRole('button', { name: /Confirm receipt & release/i }))
    await waitFor(() => screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: /Release USDC/i }))

    await waitFor(() => expect(mockSubmit).toHaveBeenCalled())
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('checkbox')).toBeTruthy()

    resolveSubmit({ status: 'PENDING' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
  })

  it('shows Completed label for RELEASED status', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'RELEASED' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByText(/Completed/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Lock USDC/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /Confirm receipt & release/i })).toBeNull()
  })
})

describe('AssignmentCard — WITHDRAW (LP pays fiat)', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  it('FUNDED: shows the seller bank + Mark fiat paid, gated by the checkbox', async () => {
    const order = makeOrder({
      status: 'FUNDED',
      flow: 'WITHDRAW',
      payment_instructions: 'BCA 999 a/n Seller',
    })
    vi.mocked(apiClient.getMarkPaidTx).mockResolvedValue({
      xdr: 'PAID_XDR',
      networkPassphrase: 'np',
    })
    const submit = vi.fn().mockResolvedValue({ status: 'PENDING' })

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard assignment={{ order }} onRefetch={vi.fn()} submitFn={submit} />
      </TestProviders>,
    )

    expect(screen.getByText(/BCA 999 a\/n Seller/)).toBeTruthy()
    const btn = screen.getByRole('button', { name: /Mark fiat paid/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox'))
    expect(btn.disabled).toBe(false)

    fireEvent.click(btn)
    await waitFor(() => {
      expect(apiClient.getMarkPaidTx).toHaveBeenCalledWith(expect.anything(), order.id)
      expect(submit).toHaveBeenCalled()
    })
  })

  it('shows the USDC the provider will actually receive on a withdrawal: the gross less the platform fee, which the escrow pays elsewhere', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'FUNDED', flow: 'WITHDRAW', usdc_amount: '100000000', platform_fee_bps: 30 }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByText(/Receive 9\.97 USDC/)).toBeTruthy()
    expect(screen.queryByText(/Receive 10\.00 USDC/)).toBeNull()
  })

  it('still shows the full gross the provider must lock on a deposit, because create_trade moves all of it', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'MATCHED', flow: 'TOP_UP', usdc_amount: '100000000', platform_fee_bps: 30 }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByText(/Provide 10\.00 USDC/)).toBeTruthy()
  })

  it('MATCHED: LP waits for the seller to lock USDC (no Lock button)', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'MATCHED', flow: 'WITHDRAW' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByText(/Waiting for seller to lock USDC/i)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Lock USDC/i })).toBeNull()
  })

  it('tells the provider why the bank account is withheld on a FUNDED withdrawal whose customer is not yet verified', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'FUNDED', flow: 'WITHDRAW', payment_instructions_withheld: 'kyc_required' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByText(/Withheld until the customer finishes identity verification/i)).toBeTruthy()
  })

  it('says nothing about withholding on a FUNDED withdrawal whose customer is verified', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'FUNDED', flow: 'WITHDRAW' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.queryByText(/Withheld until the customer finishes identity verification/i)).toBeNull()
  })
})

describe('AssignmentCard — Open dispute (WITHDRAW FIAT_PAID)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    queryClient.clear()
  })

  function mountFiatPaidWithdrawal() {
    return render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ flow: 'WITHDRAW', status: 'FIAT_PAID' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )
  }

  it('shows the coordinator refusal when the dispute transaction cannot be built, instead of looking like success', async () => {
    vi.mocked(apiClient.getRaiseDisputeTx).mockRejectedValueOnce(new Error('disputes are closed on this order'))
    mountFiatPaidWithdrawal()

    fireEvent.click(screen.getByTestId('lp-open-dispute'))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/disputes are closed on this order/)
    })
    expect((screen.getByTestId('lp-open-dispute') as HTMLButtonElement).disabled).toBe(false)
  })

  it('shows the wallet rejection when the LP declines to sign the dispute', async () => {
    vi.mocked(apiClient.getRaiseDisputeTx).mockResolvedValueOnce({ xdr: 'XDR', networkPassphrase: 'np' })
    vi.mocked(fakeKit.signTransaction).mockRejectedValueOnce(new Error('User rejected transaction'))
    mountFiatPaidWithdrawal()

    fireEvent.click(screen.getByTestId('lp-open-dispute'))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toMatch(/User rejected transaction/)
    })
  })
})

describe('AssignmentCard — proof upload (WITHDRAW FUNDED)', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  it('uploads a valid file via uploadProof and refetches', async () => {
    vi.mocked(apiClient.uploadProof).mockResolvedValue(makeOrder({ status: 'FUNDED', proof_url: '/uploads/x.jpg' }))
    const mockRefetch = vi.fn()
    const order = makeOrder({
      id: 'order-funded-1',
      status: 'FUNDED',
      flow: 'WITHDRAW',
      payment_instructions: 'BCA 999 a/n Seller',
    })

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard assignment={{ order }} onRefetch={mockRefetch} />
      </TestProviders>,
    )

    const file = new File(['bytes'], 'receipt.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('proof-upload-input'), { target: { files: [file] } })

    await waitFor(() => {
      expect(apiClient.uploadProof).toHaveBeenCalledWith(expect.anything(), 'order-funded-1', file, undefined)
      expect(mockRefetch).toHaveBeenCalled()
    })
  })

  const tlv = (id: string, val: string) => id + String(val.length).padStart(2, '0') + val
  const STATIC_QRIS_PAYLOAD =
    tlv('00', '01') + tlv('01', '11') + tlv('53', '360') + tlv('59', 'WARUNG BU') + '6304AAAA'
  const DYNAMIC_QRIS_PAYLOAD =
    tlv('00', '01') + tlv('01', '12') + tlv('53', '360') + tlv('54', '25000') + tlv('59', 'KASIR') + '6304AAAA'

  it('WITHDRAW: still shows the seller bank details as text (no QR image)', async () => {
    const order = makeOrder({
      status: 'FUNDED',
      flow: 'WITHDRAW',
      payment_instructions: 'BCA 999 a/n Seller',
    })
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard assignment={{ order }} onRefetch={vi.fn()} />
      </TestProviders>,
    )
    expect(screen.getByText('BCA 999 a/n Seller')).toBeTruthy()
    expect(screen.queryByTestId('qris-image')).toBeNull()
    expect(screen.queryByTestId('qris-image-loading')).toBeNull()
  })

  it('rejects an oversized file client-side without calling uploadProof', () => {
    const order = makeOrder({ status: 'FUNDED', flow: 'WITHDRAW' })

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard assignment={{ order }} onRefetch={vi.fn()} />
      </TestProviders>,
    )

    const bigFile = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('proof-upload-input'), { target: { files: [bigFile] } })

    expect(screen.getByText(/File too large/i)).toBeTruthy()
    expect(apiClient.uploadProof).not.toHaveBeenCalled()
  })

  it('rejects an unsupported file type client-side', () => {
    const order = makeOrder({ status: 'FUNDED', flow: 'WITHDRAW' })

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard assignment={{ order }} onRefetch={vi.fn()} />
      </TestProviders>,
    )

    const badFile = new File(['bytes'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('proof-upload-input'), { target: { files: [badFile] } })

    expect(screen.getByText(/Unsupported file type/i)).toBeTruthy()
    expect(apiClient.uploadProof).not.toHaveBeenCalled()
  })

  it('shows the uploaded state and hides the file input once order.proof_url is set', () => {
    const order = makeOrder({ status: 'FUNDED', flow: 'WITHDRAW', proof_url: '/uploads/existing.jpg' })

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard assignment={{ order }} onRefetch={vi.fn()} />
      </TestProviders>,
    )

    expect(screen.getByTestId('proof-uploaded')).toBeTruthy()
    expect(screen.queryByTestId('proof-upload-input')).toBeNull()
  })

  it('require_proof=true, no proof yet: Mark-paid stays disabled (even checked) and shows the hint', () => {
    const order = makeOrder({ status: 'FUNDED', flow: 'WITHDRAW', proof_url: null })

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order, require_proof: true }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    fireEvent.click(screen.getByRole('checkbox'))
    const btn = screen.getByRole('button', { name: /Mark fiat paid/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)
    expect(screen.getByTestId('proof-required-hint')).toBeTruthy()
    expect(screen.getByText(/Upload your transfer receipt first/i)).toBeTruthy()
  })

  it('require_proof=true, proof already uploaded: Mark-paid enables once checked', () => {
    const order = makeOrder({
      status: 'FUNDED',
      flow: 'WITHDRAW',
      proof_url: '/uploads/receipt.jpg',
    })

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order, require_proof: true }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    const btn = screen.getByRole('button', { name: /Mark fiat paid/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(true)

    fireEvent.click(screen.getByRole('checkbox'))
    expect(btn.disabled).toBe(false)
    expect(screen.queryByTestId('proof-required-hint')).toBeNull()
  })

  it('require_proof=false: Mark-paid is never gated by proof, regardless of upload state', () => {
    const order = makeOrder({ status: 'FUNDED', flow: 'WITHDRAW', proof_url: null })

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order, require_proof: false }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    fireEvent.click(screen.getByRole('checkbox'))
    const btn = screen.getByRole('button', { name: /Mark fiat paid/i }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(screen.queryByTestId('proof-required-hint')).toBeNull()
  })
})

describe('AssignmentCard — TOP_UP transfer ref (FUNDED)', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  it('shows the ref chip with the "Buyer must include this reference" copy when present', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'FUNDED', flow: 'TOP_UP', ref: 'LP-AB12' }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByText(/Buyer must include this reference/i)).toBeTruthy()
    expect(screen.getByTestId('lp-transfer-ref')).toHaveTextContent('LP-AB12')
  })

  it('omits the ref chip entirely when the order carries no ref', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'FUNDED', flow: 'TOP_UP', ref: null }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.queryByTestId('lp-transfer-ref')).toBeNull()
  })
})

describe('AssignmentsPage — full page', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  it('shows loading state while assignments are fetching', () => {
    vi.mocked(apiClient.getAssignments).mockReturnValue(new Promise(() => {}))

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentsPage />
      </TestProviders>,
    )

    expect(screen.getByText(/Loading assignments/i)).toBeTruthy()
  })

  it('shows empty state when no assignments returned', async () => {
    vi.mocked(apiClient.getAssignments).mockResolvedValue([])

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/No assignments yet/i)).toBeTruthy()
    })
  })

  it('renders assignment cards when data is available', async () => {
    vi.mocked(apiClient.getAssignments).mockResolvedValue([
      { order: makeOrder({ status: 'MATCHED' }) },
    ])

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/Provide 100\.00 USDC/)).toBeTruthy()
      expect(screen.getByRole('button', { name: /Lock USDC/i })).toBeTruthy()
    })
  })

  it('shows error state when getAssignments fails', async () => {
    vi.mocked(apiClient.getAssignments).mockRejectedValue(new Error('Network error'))

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(screen.getByText(/Failed to load assignments/i)).toBeTruthy()
    })
  })
})
