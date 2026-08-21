'use client'

import * as React from 'react'
import { BottomSheet } from '@lolipay/ui'
import type { DisputeReason, Flow } from '@lolipay/api-client'
import { useDisputeSubmit, type SubmitFn } from '@/hooks/useDisputeSubmit'

const NOTE_MAX_LEN = 500

const TOP_UP_REASONS: { value: DisputeReason; label: string }[] = [
  { value: 'USDC_NOT_RELEASED', label: 'USDC not released' },
  { value: 'PAID_WRONG_AMOUNT', label: 'Paid the wrong amount' },
  { value: 'OTHER', label: 'Other' },
]
const FIAT_PAYER_REASONS: { value: DisputeReason; label: string }[] = [
  { value: 'PAYMENT_NOT_RECEIVED', label: 'Payment not received' },
  { value: 'WRONG_AMOUNT', label: 'Wrong amount' },
  { value: 'FAKE_PROOF', label: 'Proof looks fake' },
  { value: 'OTHER', label: 'Other' },
]

function reasonsFor(flow: Flow) {
  return flow === 'TOP_UP' ? TOP_UP_REASONS : FIAT_PAYER_REASONS
}

const MAX_EVIDENCE_BYTES = 5 * 1024 * 1024
const ACCEPTED_EVIDENCE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

interface Props {
  orderId: string
  flow: Flow
  open: boolean
  onClose: () => void
  onSubmitted: () => void

  submitFn?: SubmitFn
}

export function DisputeForm({ orderId, flow, open, onClose, onSubmitted, submitFn }: Props) {
  const [reason, setReason] = React.useState<DisputeReason | null>(null)
  const [note, setNote] = React.useState('')
  const [file, setFile] = React.useState<File | null>(null)
  const [fileError, setFileError] = React.useState<string | null>(null)
  const { submit, isPending, error, reset } = useDisputeSubmit(submitFn)

  React.useEffect(() => {
    if (open) {
      setReason(null)
      setNote('')
      setFile(null)
      setFileError(null)
      reset()
    }
  }, [open, reset])

  const reasons = reasonsFor(flow)
  const trimmedNote = note.trim()
  const canSubmit = !!reason && trimmedNote.length > 0 && !isPending

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!f) {
      setFile(null)
      setFileError(null)
      return
    }
    if (!ACCEPTED_EVIDENCE_TYPES.includes(f.type)) {
      setFileError('Unsupported file type — use JPG, PNG, WEBP, or PDF.')
      setFile(null)
      return
    }
    if (f.size > MAX_EVIDENCE_BYTES) {
      setFileError('File too large — max 5MB.')
      setFile(null)
      return
    }
    setFileError(null)
    setFile(f)
  }

  async function handleSubmit() {
    if (!reason) return
    try {
      await submit({ orderId, reason, note: trimmedNote, file })
      onSubmitted()
    } catch {
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} ariaLabel="What went wrong?" dismissible={!isPending}>
      <h2 className="mb-4 font-geist text-lg font-bold text-lp-ink">What went wrong?</h2>

      <div className="mb-4 flex flex-wrap gap-2">
        {reasons.map((r) => (
          <button
            key={r.value}
            type="button"
            data-testid={`dispute-reason-${r.value}`}
            aria-pressed={reason === r.value}
            onClick={() => setReason(r.value)}
            className={
              'rounded-full border px-3.5 py-2 text-[13px] font-semibold transition ' +
              (reason === r.value
                ? 'border-lp-accent bg-lp-accent-soft text-lp-accent-ink'
                : 'border-lp-line bg-lp-raise text-lp-ink-soft')
            }
          >
            {r.label}
          </button>
        ))}
      </div>

      <label htmlFor="dispute-note" className="mb-1 block text-xs font-semibold text-lp-muted">
        Tell us what happened
      </label>
      <textarea
        id="dispute-note"
        data-testid="dispute-note"
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX_LEN))}
        maxLength={NOTE_MAX_LEN}
        rows={4}
        placeholder="Describe the issue — the more detail, the faster this resolves."
        className="mb-1 w-full resize-none rounded-[10px] border border-lp-line bg-lp-raise px-3 py-2.5 text-sm text-lp-ink outline-none"
      />
      <p className="mb-4 text-right text-[11px] text-lp-faint">
        {trimmedNote.length}/{NOTE_MAX_LEN}
      </p>

      <label htmlFor="dispute-evidence" className="mb-1 block text-xs font-semibold text-lp-muted">
        Evidence (optional)
      </label>
      <input
        id="dispute-evidence"
        data-testid="dispute-evidence"
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        onChange={handleFileChange}
        className="mb-1 w-full text-xs text-lp-ink-soft"
      />
      {file && !fileError && (
        <p className="mb-2 text-xs text-lp-muted">Attached: {file.name}</p>
      )}
      {fileError && (
        <p className="mb-2 text-xs text-lp-danger" role="alert">
          {fileError}
        </p>
      )}

      {error && (
        <p className="mb-3 text-sm text-lp-danger" role="alert">
          {error.message}
        </p>
      )}

      <div className="mt-3 space-y-2">
        <button
          type="button"
          data-testid="dispute-submit"
          disabled={!canSubmit}
          onClick={handleSubmit}
          className="w-full rounded-lp-cta bg-lp-danger py-3.5 font-geist text-[15px] font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? (
            <span aria-label="loading" className="inline-block animate-spin">
              ◌
            </span>
          ) : (
            'Submit dispute — sign'
          )}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={isPending}
          className="w-full py-3 text-center font-geist text-sm font-semibold text-lp-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          Cancel
        </button>
      </div>
    </BottomSheet>
  )
}
