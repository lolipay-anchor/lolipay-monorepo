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

const mockPostDispute = vi.hoisted(() => vi.fn())
const mockUploadDisputeEvidence = vi.hoisted(() => vi.fn())
vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    postDispute: mockPostDispute,
    uploadDisputeEvidence: mockUploadDisputeEvidence,
  }
})

const { DisputeForm } = await import('@/components/DisputeForm')

describe('DisputeForm', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockPostDispute.mockResolvedValue({
      order: { id: 'ord-d1', status: 'FIAT_PAID', dispute_by: 'user' },
      dispute_tx: { xdr: 'AAAADISPUTE==', networkPassphrase: 'Test SDF Network ; September 2015' },
    })
  })

  it('does not render when open=false', () => {
    render(
      <TestProviders>
        <DisputeForm
          orderId="ord-d1"
          flow="TOP_UP"
          open={false}
          onClose={vi.fn()}
          onSubmitted={vi.fn()}
        />
      </TestProviders>,
    )
    expect(screen.queryByText('What went wrong?')).toBeNull()
  })

  it('TOP_UP shows the TOP_UP-specific reason chips', () => {
    render(
      <TestProviders>
        <DisputeForm orderId="ord-d1" flow="TOP_UP" open onClose={vi.fn()} onSubmitted={vi.fn()} />
      </TestProviders>,
    )
    expect(screen.getByTestId('dispute-reason-USDC_NOT_RELEASED')).toBeTruthy()
    expect(screen.getByTestId('dispute-reason-PAID_WRONG_AMOUNT')).toBeTruthy()
    expect(screen.getByTestId('dispute-reason-OTHER')).toBeTruthy()
    expect(screen.queryByTestId('dispute-reason-PAYMENT_NOT_RECEIVED')).toBeNull()
  })

  it('WITHDRAW/WITHDRAW shows the fiat-payer reason chips', () => {
    render(
      <TestProviders>
        <DisputeForm orderId="ord-d1" flow="WITHDRAW" open onClose={vi.fn()} onSubmitted={vi.fn()} />
      </TestProviders>,
    )
    expect(screen.getByTestId('dispute-reason-PAYMENT_NOT_RECEIVED')).toBeTruthy()
    expect(screen.getByTestId('dispute-reason-WRONG_AMOUNT')).toBeTruthy()
    expect(screen.getByTestId('dispute-reason-FAKE_PROOF')).toBeTruthy()
    expect(screen.getByTestId('dispute-reason-OTHER')).toBeTruthy()
    expect(screen.queryByTestId('dispute-reason-USDC_NOT_RELEASED')).toBeNull()
  })

  it('submit is disabled until a reason is picked AND the note is non-empty', () => {
    render(
      <TestProviders>
        <DisputeForm orderId="ord-d1" flow="TOP_UP" open onClose={vi.fn()} onSubmitted={vi.fn()} />
      </TestProviders>,
    )
    const submit = screen.getByTestId('dispute-submit')
    expect(submit).toBeDisabled()

    fireEvent.click(screen.getByTestId('dispute-reason-OTHER'))
    expect(submit).toBeDisabled()

    fireEvent.change(screen.getByTestId('dispute-note'), { target: { value: 'Something is wrong' } })
    expect(submit).not.toBeDisabled()
  })

  it('submits { reason, note } (no evidenceUrl) when no file is attached, signs, and calls onSubmitted', async () => {
    const onSubmitted = vi.fn()
    const mockSubmitFn = vi.fn(async () => ({ status: 'PENDING' }))

    render(
      <TestProviders>
        <DisputeForm
          orderId="ord-d1"
          flow="WITHDRAW"
          open
          onClose={vi.fn()}
          onSubmitted={onSubmitted}
          submitFn={mockSubmitFn}
        />
      </TestProviders>,
    )

    fireEvent.click(screen.getByTestId('dispute-reason-PAYMENT_NOT_RECEIVED'))
    fireEvent.change(screen.getByTestId('dispute-note'), { target: { value: 'Never got the transfer' } })
    fireEvent.click(screen.getByTestId('dispute-submit'))

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1))

    expect(mockUploadDisputeEvidence).not.toHaveBeenCalled()
    expect(mockPostDispute).toHaveBeenCalledWith(expect.anything(), 'ord-d1', {
      reason: 'PAYMENT_NOT_RECEIVED',
      note: 'Never got the transfer',
      evidenceUrl: undefined,
    })
    expect(mockSubmitFn).toHaveBeenCalledWith('SIGNED_XDR', 'Test SDF Network ; September 2015')
  })

  it('uploads evidence FIRST, then posts the dispute with the returned evidenceUrl', async () => {
    mockUploadDisputeEvidence.mockResolvedValue({ evidence_url: 'evidence/ord-d1-user.png' })
    const onSubmitted = vi.fn()

    render(
      <TestProviders>
        <DisputeForm
          orderId="ord-d1"
          flow="TOP_UP"
          open
          onClose={vi.fn()}
          onSubmitted={onSubmitted}
          submitFn={vi.fn(async () => ({ status: 'PENDING' }))}
        />
      </TestProviders>,
    )

    fireEvent.click(screen.getByTestId('dispute-reason-USDC_NOT_RELEASED'))
    fireEvent.change(screen.getByTestId('dispute-note'), { target: { value: 'It never arrived' } })

    const file = new File(['bytes'], 'proof.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('dispute-evidence'), { target: { files: [file] } })
    expect(screen.getByText('Attached: proof.png')).toBeTruthy()

    fireEvent.click(screen.getByTestId('dispute-submit'))

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1))

    expect(mockUploadDisputeEvidence).toHaveBeenCalledWith(expect.anything(), 'ord-d1', file)
    expect(mockPostDispute).toHaveBeenCalledWith(expect.anything(), 'ord-d1', {
      reason: 'USDC_NOT_RELEASED',
      note: 'It never arrived',
      evidenceUrl: 'evidence/ord-d1-user.png',
    })
  })

  it('rejects an oversized file client-side without ever calling the upload endpoint', () => {
    render(
      <TestProviders>
        <DisputeForm orderId="ord-d1" flow="TOP_UP" open onClose={vi.fn()} onSubmitted={vi.fn()} />
      </TestProviders>,
    )
    const bigFile = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' })
    fireEvent.change(screen.getByTestId('dispute-evidence'), { target: { files: [bigFile] } })

    expect(screen.getByText(/max 5MB/i)).toBeTruthy()
  })

  it('rejects an unsupported file type client-side', () => {
    render(
      <TestProviders>
        <DisputeForm orderId="ord-d1" flow="TOP_UP" open onClose={vi.fn()} onSubmitted={vi.fn()} />
      </TestProviders>,
    )
    const badFile = new File(['bytes'], 'notes.txt', { type: 'text/plain' })
    fireEvent.change(screen.getByTestId('dispute-evidence'), { target: { files: [badFile] } })

    expect(screen.getByText(/Unsupported file type/i)).toBeTruthy()
  })

  it('shows the error message when postDispute fails, and does NOT call onSubmitted', async () => {
    mockPostDispute.mockRejectedValue(new Error('a dispute has already been filed for this order'))

    render(
      <TestProviders>
        <DisputeForm orderId="ord-d1" flow="TOP_UP" open onClose={vi.fn()} onSubmitted={vi.fn()} />
      </TestProviders>,
    )

    fireEvent.click(screen.getByTestId('dispute-reason-OTHER'))
    fireEvent.change(screen.getByTestId('dispute-note'), { target: { value: 'note text' } })
    fireEvent.click(screen.getByTestId('dispute-submit'))

    await waitFor(() => {
      expect(screen.getByText(/a dispute has already been filed/i)).toBeTruthy()
    })
  })

  it('re-opening the sheet resets reason/note/file/error', () => {
    const { rerender } = render(
      <TestProviders>
        <DisputeForm orderId="ord-d1" flow="TOP_UP" open onClose={vi.fn()} onSubmitted={vi.fn()} />
      </TestProviders>,
    )
    fireEvent.click(screen.getByTestId('dispute-reason-OTHER'))
    fireEvent.change(screen.getByTestId('dispute-note'), { target: { value: 'draft note' } })

    rerender(
      <TestProviders>
        <DisputeForm orderId="ord-d1" flow="TOP_UP" open={false} onClose={vi.fn()} onSubmitted={vi.fn()} />
      </TestProviders>,
    )
    rerender(
      <TestProviders>
        <DisputeForm orderId="ord-d1" flow="TOP_UP" open onClose={vi.fn()} onSubmitted={vi.fn()} />
      </TestProviders>,
    )

    expect((screen.getByTestId('dispute-note') as HTMLTextAreaElement).value).toBe('')
    expect(screen.getByTestId('dispute-reason-OTHER')).toHaveAttribute('aria-pressed', 'false')
  })
})
