import * as React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
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
    getConfirmReceiptMessage: vi.fn(),
    confirmReceipt: vi.fn(),

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
    refund_opens_at: 0,
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
    expect(screen.getByRole('button', { name: 'Lock USDC' })).toBeTruthy()
    expect(screen.getByText(/MATCHED/)).toBeTruthy()
  })

  it('rounds a long-precision wire rate to whole rupiah, never printing the raw string', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{
            order: makeOrder({
              status: 'MATCHED',
              rate_snapshot: '17976.497988795364408085265',
            }),
          }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByText('Rate: Rp 17.976')).toBeTruthy()
    expect(screen.queryByText(/17976\.497988795364408085265/)).toBeNull()
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

    expect(screen.getByRole('button', { name: 'Lock USDC' })).toBeTruthy()
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

    fireEvent.click(screen.getByRole('button', { name: 'Lock USDC' }))

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

    fireEvent.click(screen.getByRole('button', { name: 'Lock USDC' }))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeTruthy()
      expect(screen.getByText(/User rejected transaction/i)).toBeTruthy()
    })
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

    expect(screen.getByRole('button', { name: 'Confirm receipt & release' })).toBeTruthy()
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

    fireEvent.click(screen.getByRole('button', { name: 'Confirm receipt & release' }))

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

    fireEvent.click(screen.getByRole('button', { name: 'Confirm receipt & release' }))

    await waitFor(() => screen.getByRole('checkbox'))

    const releaseBtn = screen.getByRole('button', { name: 'Release USDC — sign' })

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

    fireEvent.click(screen.getByRole('button', { name: 'Confirm receipt & release' }))
    await waitFor(() => screen.getByRole('checkbox'))

    fireEvent.click(screen.getByRole('checkbox'))

    fireEvent.click(screen.getByRole('button', { name: 'Release USDC — sign' }))

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

    fireEvent.click(screen.getByRole('button', { name: 'Confirm receipt & release' }))
    await waitFor(() => screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: 'Release USDC — sign' }))

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
    expect(screen.queryByTestId('lp-open-dispute')).toBeNull()
  })

  it('offers a post-settlement dispute link on RELEASED while the window is still open', () => {
    const stillOpen = new Date(Date.now() + 3600_000).toISOString()
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'RELEASED', post_settle_dispute_until: stillOpen }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByTestId('lp-open-dispute')).toBeTruthy()
  })

  it('offers a post-settlement dispute link on REFUNDED while the window is still open', () => {
    const stillOpen = new Date(Date.now() + 3600_000).toISOString()
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'REFUNDED', post_settle_dispute_until: stillOpen }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByTestId('lp-open-dispute')).toBeTruthy()
  })

  it('hides the post-settlement dispute link once the window has closed', () => {
    const closed = new Date(Date.now() - 1_000).toISOString()
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'RELEASED', post_settle_dispute_until: closed }) }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.queryByTestId('lp-open-dispute')).toBeNull()
  })
})

const WINDOW_END = 1_790_000_000
const AT = 1_790_000_123
const NP = 'Test SDF Network ; September 2015'
const LP_ADDR = 'GLPSENTINELADDRESSDIFFERENTFROMTHEKITADDRESS'
const SIG = 'SIGNATURE_FROM_THE_KIT'
const MSG = 'lolipay-confirm-receipt:v1 server-built statement order=order-1 reference=SRV-REF at=1790000123'

const nowSecs = () => Math.floor(Date.now() / 1000)
const when = (secs: number) => new Date(secs * 1000).toLocaleString().replace(/\s+/g, ' ')

const CARD_BUTTON = 'Confirm receipt & release'
const SIGN_TWICE_LABEL = 'Confirm receipt & release — sign twice'
const RELEASE_LABEL = 'Release USDC — sign'
const CLAUSE_INTRO = 'Your wallet will ask you to sign twice:'
const CLAUSE_STATEMENT =
  'A statement that you received the full payment. Declining it records nothing. Signing it lets lolipay mark this order as paid on chain, and once it is marked that cannot be undone, even if you decline the second request: the USDC can then only be released, or settled through a dispute.'
const CLAUSE_RELEASE = 'The release, which sends the USDC to the buyer.'
const DID_NOT_SIGN = 'Your wallet did not sign the statement, so nothing was recorded.'
const RELEASE_NOT_SIGNED = 'Your wallet did not sign the release, so nothing was sent.'
const MARKED_RELEASE_NOT_SIGNED = 'This order is now marked as paid on chain, but your wallet did not sign the release, so nothing was sent. Press Release USDC — sign to try again.'
const KIT_DECLINE = { code: -4, message: 'User declined access' }
const MARKUP_REF = 'LP-9Z7Q<i>x</i>'

const openWindowSentence = (end: number) =>
  `Check that Rp 1.500.000 has arrived in your BANK account. If it has, press Confirm receipt & release and approve both requests in your wallet: that records the payment on chain and releases the USDC to the buyer. Do it before ${when(end)}; after that it can no longer be confirmed, and the USDC can be returned to you.`
const closedWindowSentence = (end: number) =>
  `The time to confirm this payment ended at ${when(end)}. It can no longer be confirmed, and the USDC can be returned to you.`
const markedButNotReleased = (reason: string) =>
  `This order is now marked as paid on chain, but the release did not complete here: ${reason}. Press Release USDC — sign to try again.`

const fundedCard = (overrides: Partial<Order> = {}) => (
  <TestProviders kit={fakeKit}>
    <AssignmentCard
      assignment={{ order: makeOrder({ status: 'FUNDED', ...overrides }) }}
      onRefetch={vi.fn()}
    />
  </TestProviders>
)

describe('AssignmentCard — TOP_UP FUNDED: the card and its window (F1, F2)', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  it('F1: inside the window it says where to check, offers Confirm receipt & release, keeps the reference, and claims nothing about the buyer', () => {
    const end = nowSecs() + 3600
    render(fundedCard({ refund_opens_at: end, ref: 'LP-AB12' }))

    expect(screen.getByText(openWindowSentence(end))).toBeTruthy()
    expect(screen.getByRole('button', { name: CARD_BUTTON })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Lock USDC/i })).toBeNull()
    expect(screen.queryByText(/Waiting for buyer's payment/i)).toBeNull()
    expect(screen.getByTestId('lp-transfer-ref')).toHaveTextContent('LP-AB12')
  })

  it('F2: past refund_opens_at it says the time ended and offers no button', () => {
    render(fundedCard({ refund_opens_at: 1_000 }))

    expect(screen.getByText(closedWindowSentence(1_000))).toBeTruthy()
    expect(screen.queryByRole('button', { name: CARD_BUTTON })).toBeNull()
    expect(screen.queryByRole('button', { name: /Lock USDC/i })).toBeNull()
    expect(screen.queryByText(/Do it before/i)).toBeNull()
  })

  it('F2: refund_opens_at itself is still inside the window and the next second is not', () => {
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(WINDOW_END * 1000 + 999)
      const view = render(fundedCard({ refund_opens_at: WINDOW_END }))
      expect(screen.getByRole('button', { name: CARD_BUTTON })).toBeTruthy()

      nowSpy.mockReturnValue((WINDOW_END + 1) * 1000)
      view.rerender(fundedCard({ refund_opens_at: WINDOW_END }))
      expect(screen.queryByRole('button', { name: CARD_BUTTON })).toBeNull()
      expect(screen.getByText(closedWindowSentence(WINDOW_END))).toBeTruthy()
    } finally {
      nowSpy.mockRestore()
    }
  })
})

function mountTopUp(status: 'FUNDED' | 'FIAT_PAID', overrides: Partial<Order> = {}) {
  const onRefetch = vi.fn()
  const submit = vi.fn().mockResolvedValue({ status: 'PENDING' })
  const order = makeOrder({ status, refund_opens_at: nowSecs() + 3600, ref: 'LP-AB12', ...overrides })
  const element = (o: Order) => (
    <TestProviders kit={fakeKit}>
      <AssignmentCard assignment={{ order: o }} onRefetch={onRefetch} submitFn={submit} />
    </TestProviders>
  )
  const view = render(element(order))
  return { view, element, order, onRefetch, submit }
}

function openSheetAndTick() {
  fireEvent.click(screen.getByRole('button', { name: CARD_BUTTON }))
  fireEvent.click(screen.getByRole('checkbox'))
}

const queueStatement = (at = AT) =>
  vi.mocked(apiClient.getConfirmReceiptMessage).mockResolvedValueOnce({ message: MSG, at })
const queueReceiptRecorded = () =>
  vi.mocked(apiClient.confirmReceipt).mockResolvedValueOnce({
    orderId: 'order-1',
    submission: 'SUCCESS',
    txHash: 'TXH',
  })
const queueReleaseTx = () =>
  vi.mocked(apiClient.getConfirmReleaseTx).mockResolvedValueOnce({
    xdr: 'CONFIRM_XDR',
    networkPassphrase: NP,
  })

async function recordThenFailTheRelease(rejection: unknown = new Error('User rejected transaction')) {
  queueStatement()
  queueReceiptRecorded()
  queueReleaseTx()
  vi.mocked(fakeKit.signTransaction).mockRejectedValueOnce(rejection)
  const mounted = mountTopUp('FUNDED')
  openSheetAndTick()
  fireEvent.click(screen.getByRole('button', { name: SIGN_TWICE_LABEL }))
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
  return mounted
}

function drainMocks() {
  vi.mocked(apiClient.getConfirmReceiptMessage).mockReset()
  vi.mocked(apiClient.confirmReceipt).mockReset()
  vi.mocked(apiClient.getConfirmReleaseTx).mockReset()
  vi.mocked(fakeKit.signMessage).mockReset()
  vi.mocked(fakeKit.signTransaction).mockReset()
  sessionStorage.clear()
}

describe('ConfirmReleaseSheet — records the receipt, then releases (F3–F6, F8)', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
    drainMocks()
  })

  afterEach(drainMocks)

  it('at FUNDED the sheet says the wallet will ask twice, in the ruled words, and labels the button to match', () => {
    mountTopUp('FUNDED')
    fireEvent.click(screen.getByRole('button', { name: CARD_BUTTON }))

    expect(screen.getByText(CLAUSE_INTRO)).toBeTruthy()
    expect(screen.getByText(CLAUSE_STATEMENT)).toBeTruthy()
    expect(screen.getByText(CLAUSE_RELEASE)).toBeTruthy()
    expect(screen.getByRole('button', { name: SIGN_TWICE_LABEL })).toBeTruthy()
    expect(screen.queryByRole('button', { name: RELEASE_LABEL })).toBeNull()
    expect(screen.getByText(/Releasing without receiving funds loses your USDC/)).toBeTruthy()
  })

  it('at FUNDED the sheet shows order.ref exactly, as plain text, in a Reference row beside Via', () => {
    mountTopUp('FUNDED', { ref: MARKUP_REF })
    fireEvent.click(screen.getByRole('button', { name: CARD_BUTTON }))

    const dialog = within(screen.getByRole('dialog'))
    const row = dialog.getByText('Reference').parentElement
    expect(row?.textContent).toBe(`Reference${MARKUP_REF}`)
    expect(row?.parentElement).toBe(dialog.getByText('Via').parentElement?.parentElement)
  })

  it('with no ref the sheet shows no Reference row, and still shows Amount to receive and Via', () => {
    mountTopUp('FUNDED', { ref: null })
    fireEvent.click(screen.getByRole('button', { name: CARD_BUTTON }))

    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('Amount to receive')).toBeTruthy()
    expect(dialog.getByText('Via')).toBeTruthy()
    expect(dialog.queryByText('Reference')).toBeNull()
  })

  it('F3: signs the server statement as the logged-in account, posts a fresh { at, signature }, then releases — in that order', async () => {
    sessionStorage.setItem('lp_addr', LP_ADDR)
    queueStatement()
    vi.mocked(fakeKit.signMessage).mockResolvedValueOnce({ signedMessage: SIG })
    queueReceiptRecorded()
    queueReleaseTx()
    const { submit } = mountTopUp('FUNDED')
    openSheetAndTick()

    fireEvent.click(screen.getByRole('button', { name: SIGN_TWICE_LABEL }))
    await waitFor(() => expect(submit).toHaveBeenCalled())

    expect(apiClient.getConfirmReceiptMessage).toHaveBeenCalledWith(expect.anything(), 'order-1')
    expect(fakeKit.signMessage).toHaveBeenCalledWith(MSG, { address: LP_ADDR })
    const posted = vi.mocked(apiClient.confirmReceipt).mock.calls[0]
    expect(posted[1]).toBe('order-1')
    expect(posted[2]).toStrictEqual({ at: AT, signature: SIG })
    expect(apiClient.getConfirmReleaseTx).toHaveBeenCalledWith(expect.anything(), 'order-1')
    expect(fakeKit.signTransaction).toHaveBeenCalledWith('CONFIRM_XDR', { networkPassphrase: NP })
    expect(submit).toHaveBeenCalledWith('SIGNED_XDR', NP)

    const firstCall = (m: { mock: { invocationCallOrder: number[] } }) => m.mock.invocationCallOrder[0]
    const order = [
      firstCall(vi.mocked(apiClient.getConfirmReceiptMessage)),
      firstCall(vi.mocked(fakeKit.signMessage)),
      firstCall(vi.mocked(apiClient.confirmReceipt)),
      firstCall(vi.mocked(apiClient.getConfirmReleaseTx)),
      firstCall(vi.mocked(fakeKit.signTransaction)),
      firstCall(submit),
    ]
    expect(order.every((n) => typeof n === 'number')).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('an already-recorded answer counts as recorded: the release goes ahead', async () => {
    queueStatement()
    vi.mocked(apiClient.confirmReceipt).mockResolvedValueOnce({ orderId: 'order-1', alreadyRecorded: true })
    queueReleaseTx()
    const { submit } = mountTopUp('FUNDED')
    openSheetAndTick()

    fireEvent.click(screen.getByRole('button', { name: SIGN_TWICE_LABEL }))

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  })

  it('F4: a wallet that declines with a plain { code, message } object shows the fixed sentence and calls nothing after the signature', async () => {
    queueStatement()
    vi.mocked(fakeKit.signMessage).mockRejectedValueOnce({ code: -4, message: 'User declined access' })
    const { onRefetch } = mountTopUp('FUNDED')
    openSheetAndTick()

    fireEvent.click(screen.getByRole('button', { name: SIGN_TWICE_LABEL }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(DID_NOT_SIGN))
    expect(apiClient.confirmReceipt).not.toHaveBeenCalled()
    expect(apiClient.getConfirmReleaseTx).not.toHaveBeenCalled()
    expect(onRefetch).not.toHaveBeenCalled()
  })

  it('F4: a declined statement records nothing, so the label is unchanged and the next press asks for a new statement', async () => {
    queueStatement()
    vi.mocked(fakeKit.signMessage).mockRejectedValueOnce({ code: -4, message: 'User declined access' })
    const { submit } = mountTopUp('FUNDED')
    openSheetAndTick()
    fireEvent.click(screen.getByRole('button', { name: SIGN_TWICE_LABEL }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(DID_NOT_SIGN))
    expect(screen.getByRole('button', { name: SIGN_TWICE_LABEL })).toBeTruthy()

    queueStatement(AT + 1)
    queueReceiptRecorded()
    queueReleaseTx()
    fireEvent.click(screen.getByRole('button', { name: SIGN_TWICE_LABEL }))

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(apiClient.getConfirmReceiptMessage).toHaveBeenCalledTimes(2)
    expect(fakeKit.signMessage).toHaveBeenCalledTimes(2)
  })

  it('F4: an Error from the wallet, such as its timeout, is shown as its own message, not replaced by the fixed sentence', async () => {
    const timeout = 'Waiting for you to approve the signature in your wallet timed out — please try again'
    queueStatement()
    vi.mocked(fakeKit.signMessage).mockRejectedValueOnce(new Error(timeout))
    mountTopUp('FUNDED')
    openSheetAndTick()

    fireEvent.click(screen.getByRole('button', { name: SIGN_TWICE_LABEL }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(timeout))
    expect(apiClient.confirmReceipt).not.toHaveBeenCalled()
  })

  it('F4: a refusal of the statement request is shown verbatim and nothing after it is called', async () => {
    const sentence = 'Only the provider assigned to this order can confirm its payment.'
    vi.mocked(apiClient.getConfirmReceiptMessage).mockRejectedValueOnce(new apiClient.ApiError(403, sentence))
    mountTopUp('FUNDED')
    openSheetAndTick()

    fireEvent.click(screen.getByRole('button', { name: SIGN_TWICE_LABEL }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(sentence))
    expect(fakeKit.signMessage).not.toHaveBeenCalled()
    expect(apiClient.confirmReceipt).not.toHaveBeenCalled()
    expect(apiClient.getConfirmReleaseTx).not.toHaveBeenCalled()
  })

  it('F4: a refusal of the signed statement is shown verbatim, and the release is never requested', async () => {
    const sentence =
      'The time to confirm this payment has passed, so it can no longer be confirmed, and the USDC can be returned to you.'
    queueStatement()
    vi.mocked(apiClient.confirmReceipt).mockRejectedValueOnce(new apiClient.ApiError(409, sentence))
    const { onRefetch } = mountTopUp('FUNDED')
    openSheetAndTick()

    fireEvent.click(screen.getByRole('button', { name: SIGN_TWICE_LABEL }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(sentence))
    expect(apiClient.getConfirmReleaseTx).not.toHaveBeenCalled()
    expect(onRefetch).not.toHaveBeenCalled()
  })

  it('F5: after the receipt is recorded and the release fails, the card refetches and the second press skips the statement', async () => {
    const { submit, onRefetch } = await recordThenFailTheRelease()
    expect(onRefetch).toHaveBeenCalledTimes(1)
    expect(submit).not.toHaveBeenCalled()

    queueReleaseTx()
    fireEvent.click(screen.getByRole('button', { name: RELEASE_LABEL }))

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(apiClient.getConfirmReceiptMessage).toHaveBeenCalledTimes(1)
    expect(fakeKit.signMessage).toHaveBeenCalledTimes(1)
    expect(apiClient.confirmReceipt).toHaveBeenCalledTimes(1)
    expect(apiClient.getConfirmReleaseTx).toHaveBeenCalledTimes(2)
  })

  it('F5: closing and reopening the sheet keeps the recorded receipt, so the label and the steps stay release-only', async () => {
    const { submit } = await recordThenFailTheRelease()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    fireEvent.click(screen.getByRole('button', { name: CARD_BUTTON }))
    fireEvent.click(screen.getByRole('checkbox'))

    expect(screen.queryByText(CLAUSE_INTRO)).toBeNull()
    queueReleaseTx()
    fireEvent.click(screen.getByRole('button', { name: RELEASE_LABEL }))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(apiClient.getConfirmReceiptMessage).toHaveBeenCalledTimes(1)
  })

  it('edge 18: with the receipt recorded and the release failed, the sheet says the order is marked as paid and offers Release USDC — sign without the sign-twice clause', async () => {
    await recordThenFailTheRelease()

    expect(screen.getByRole('alert').textContent).toBe(markedButNotReleased('User rejected transaction'))
    expect(screen.getByRole('button', { name: RELEASE_LABEL })).toBeTruthy()
    expect(screen.queryByRole('button', { name: SIGN_TWICE_LABEL })).toBeNull()
    expect(screen.queryByText(CLAUSE_INTRO)).toBeNull()
  })

  it('F6: at FIAT_PAID there is no statement — no clause, the release-only label, and none of the three step-1 calls', async () => {
    queueReleaseTx()
    const { submit } = mountTopUp('FIAT_PAID')
    fireEvent.click(screen.getByRole('button', { name: CARD_BUTTON }))

    expect(screen.queryByText(CLAUSE_INTRO)).toBeNull()
    expect(screen.queryByRole('button', { name: SIGN_TWICE_LABEL })).toBeNull()

    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: RELEASE_LABEL }))

    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(apiClient.getConfirmReceiptMessage).not.toHaveBeenCalled()
    expect(fakeKit.signMessage).not.toHaveBeenCalled()
    expect(apiClient.confirmReceipt).not.toHaveBeenCalled()
  })

  it('F6: at FIAT_PAID a release failure shows the wallet message as it is, not the marked-as-paid sentence', async () => {
    queueReleaseTx()
    vi.mocked(fakeKit.signTransaction).mockRejectedValueOnce(new Error('User rejected transaction'))
    mountTopUp('FIAT_PAID')
    openSheetAndTick()

    fireEvent.click(screen.getByRole('button', { name: RELEASE_LABEL }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('User rejected transaction'))
  })

  it('S1: at FIAT_PAID a wallet that declines the release with a plain { code, message } object reads that the release was not signed and nothing was sent', async () => {
    queueReleaseTx()
    vi.mocked(fakeKit.signTransaction).mockRejectedValueOnce(KIT_DECLINE)
    const { submit } = mountTopUp('FIAT_PAID')
    openSheetAndTick()

    fireEvent.click(screen.getByRole('button', { name: RELEASE_LABEL }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe(RELEASE_NOT_SIGNED))
    expect(submit).not.toHaveBeenCalled()
  })

  it('S1: after the receipt is recorded, a wallet that declines the release with a plain { code, message } object reads that the order is marked as paid and the release was not signed', async () => {
    await recordThenFailTheRelease(KIT_DECLINE)

    expect(screen.getByRole('alert').textContent).toBe(MARKED_RELEASE_NOT_SIGNED)
    expect(screen.getByRole('button', { name: RELEASE_LABEL })).toBeTruthy()
  })

  it('a plain object rejected by the release transaction request reads Release failed, never a declined signature', async () => {
    vi.mocked(apiClient.getConfirmReleaseTx).mockRejectedValueOnce({ code: 500, message: 'request refused' })
    mountTopUp('FIAT_PAID')
    openSheetAndTick()

    fireEvent.click(screen.getByRole('button', { name: RELEASE_LABEL }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Release failed'))
    expect(fakeKit.signTransaction).not.toHaveBeenCalled()
  })

  it('a plain object rejected by the submission reads Release failed, never a declined signature', async () => {
    queueReleaseTx()
    const { submit } = mountTopUp('FIAT_PAID')
    submit.mockRejectedValueOnce({ code: 500, message: 'submission refused' })
    openSheetAndTick()

    fireEvent.click(screen.getByRole('button', { name: RELEASE_LABEL }))

    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('Release failed'))
    expect(fakeKit.signTransaction).toHaveBeenCalledTimes(1)
  })

  it('after the receipt is recorded, a reason that already ends in a period reads exactly one period before Press', async () => {
    await recordThenFailTheRelease(new Error('Your wallet session expired — please reconnect your wallet.'))

    expect(screen.getByRole('alert').textContent).toBe('This order is now marked as paid on chain, but the release did not complete here: Your wallet session expired — please reconnect your wallet. Press Release USDC — sign to try again.')
  })

  it('after the receipt is recorded, only one trailing period is stripped, so a reason ending in an ellipsis keeps two of its three', async () => {
    await recordThenFailTheRelease(new Error('Waiting for the network...'))

    expect(screen.getByRole('alert').textContent).toBe('This order is now marked as paid on chain, but the release did not complete here: Waiting for the network... Press Release USDC — sign to try again.')
  })

  it('F8: the sheet stays open across the FUNDED to FIAT_PAID refetch and shows the release error', async () => {
    queueStatement()
    queueReceiptRecorded()
    queueReleaseTx()
    let rejectSign!: (e: unknown) => void
    vi.mocked(fakeKit.signTransaction).mockImplementationOnce(
      () => new Promise<{ signedTxXdr: string }>((_, reject) => { rejectSign = reject }),
    )
    const { view, element, order, submit } = mountTopUp('FUNDED')
    openSheetAndTick()
    fireEvent.click(screen.getByRole('button', { name: SIGN_TWICE_LABEL }))
    await waitFor(() => expect(fakeKit.signTransaction).toHaveBeenCalled())
    const dialog = screen.getByRole('dialog')

    view.rerender(element({ ...order, status: 'FIAT_PAID' }))
    expect(screen.getByRole('dialog')).toBe(dialog)

    rejectSign(new Error('User rejected transaction'))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(markedButNotReleased('User rejected transaction')),
    )
    expect(screen.getByRole('dialog')).toBe(dialog)
    expect(submit).not.toHaveBeenCalled()
  })

  it('F8: the sheet also stays open when the window closes while it is open, though the card button goes', () => {
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(WINDOW_END * 1000)
      const { view, element, order } = mountTopUp('FUNDED')
      fireEvent.click(screen.getByRole('button', { name: CARD_BUTTON }))
      const dialog = screen.getByRole('dialog')

      nowSpy.mockReturnValue((WINDOW_END + 3601) * 1000)
      view.rerender(element(order))

      expect(screen.getByRole('dialog')).toBe(dialog)
      expect(screen.queryByRole('button', { name: CARD_BUTTON })).toBeNull()
    } finally {
      nowSpy.mockRestore()
    }
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
    const btn = screen.getByRole('button', { name: 'Mark fiat paid — sign' }) as HTMLButtonElement
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

  it('also offers the post-settlement dispute link on a withdrawal RELEASED to the provider, while the window is open', () => {
    const stillOpen = new Date(Date.now() + 3600_000).toISOString()
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{
            order: makeOrder({ status: 'RELEASED', flow: 'WITHDRAW', post_settle_dispute_until: stillOpen }),
          }}
          onRefetch={vi.fn()}
        />
      </TestProviders>,
    )

    expect(screen.getByTestId('lp-open-dispute')).toBeTruthy()
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
    const btn = screen.getByRole('button', { name: 'Mark fiat paid — sign' }) as HTMLButtonElement
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

    const btn = screen.getByRole('button', { name: 'Mark fiat paid — sign' }) as HTMLButtonElement
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
    const btn = screen.getByRole('button', { name: 'Mark fiat paid — sign' }) as HTMLButtonElement
    expect(btn.disabled).toBe(false)
    expect(screen.queryByTestId('proof-required-hint')).toBeNull()
  })
})

describe('AssignmentCard — TOP_UP transfer ref (FUNDED)', () => {
  beforeEach(() => {
    queryClient.clear()
    vi.clearAllMocks()
  })

  it('keeps the ref chip with the "Buyer must include this reference" copy in the past-window state when the order carries a ref', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AssignmentCard
          assignment={{ order: makeOrder({ status: 'FUNDED', flow: 'TOP_UP', ref: 'LP-AB12', refund_opens_at: 1_000 }) }}
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
    expect(screen.getByText(/stake the minimum, add a payment method for your rail, and go online/i)).toBeTruthy()
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
      expect(screen.getByRole('button', { name: 'Lock USDC' })).toBeTruthy()
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
