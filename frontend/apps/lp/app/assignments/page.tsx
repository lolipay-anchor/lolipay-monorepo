'use client'

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, TransactionBuilder } from '@stellar/stellar-sdk'
import {
  getAssignments,
  getCreateTradeTx,
  getConfirmReleaseTx,
  getMarkPaidTx,
  getRaiseDisputeTx,
  getConfirmReceiptMessage,
  confirmReceipt,

  uploadProof,
} from '@lolipay/api-client'
import type { Assignment, Order } from '@lolipay/api-client'
import { submissionFailure, useWallet } from '@lolipay/wallet'
import { Card, Button, StatusPill, BottomSheet, type PillTone, NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { AppHeader } from '@/components/AppHeader'
import { useAuth } from '@/app/providers'
import { client } from '@/lib/client'
import { formatUSDC, formatIDR } from '@/lib/money'
import { useRealtimeChannel } from '@/hooks/useRealtimeChannel'

export type SubmitFn = (signedXdr: string, networkPassphrase: string) => Promise<unknown>

function retryAfter(maxTime: number) {
  return new Date(Math.ceil((maxTime + 15) / 60) * 60 * 1000).toLocaleString()
}

class OutcomeUnknown extends Error {
  maxTime: number | undefined

  constructor(maxTime: number | undefined) {
    super(
      'This has not been confirmed yet. It may already have gone through, or may still: if so, this card updates by itself. If nothing has changed, try again now. It cannot happen twice.',
    )
    this.maxTime = maxTime
  }
}

function unanswered(err: unknown) {
  if (!(err instanceof Error)) {
    return typeof err === 'object' && err !== null && 'code' in err && ![-32700, -32600, -32601, -32602].includes((err as { code: number }).code)
  }
  const { response } = err as Error & { response?: { status: number } }
  return !response || response.status >= 500
}

async function defaultSubmit(signedXdr: string, networkPassphrase: string) {
  const server = new rpc.Server(
    process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  )
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase)
  const maxTime = ('timeBounds' in tx && Number(tx.timeBounds?.maxTime)) || undefined
  const res = await server.sendTransaction(tx).catch((err: unknown) => {
    if (unanswered(err)) throw new OutcomeUnknown(maxTime)
    throw err
  })

  if (res.status === 'DUPLICATE') throw new OutcomeUnknown(maxTime)
  if (res.status !== 'PENDING') throw new Error(submissionFailure(res))

  const final = await server.pollTransaction(res.hash).catch(() => null)
  if (!final || final.status === 'NOT_FOUND') throw new OutcomeUnknown(maxTime)
  if (final.status !== 'SUCCESS') {
    throw new Error(submissionFailure({ status: final.status, errorResult: final.resultXdr }))
  }
  return final
}

const LOCK_STATUSES: Order['status'][] = ['MATCHED', 'AWAITING_ONCHAIN']
const TERMINAL_STATUSES: Order['status'][] = [
  'RELEASED', 'REFUNDED', 'CANCELLED', 'EXPIRED', 'DISPUTED',
]

function statusTone(status: Order['status']): PillTone {
  if (status === 'RELEASED') return 'green'
  if (status === 'DISPUTED') return 'danger'
  if (
    LOCK_STATUSES.includes(status) ||
    status === 'FIAT_PAID' ||
    status === 'FUNDED'
  )
    return 'amber'
  return 'neutral'
}

function truncate(addr: string) {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

const MAX_PROOF_BYTES = 5 * 1024 * 1024
const ACCEPTED_PROOF_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

const DID_NOT_SIGN = 'Your wallet did not sign the statement, so nothing was recorded.'
const DID_NOT_SIGN_RELEASE = 'Your wallet did not sign the release, so nothing was sent.'
const MARKED_DID_NOT_SIGN_RELEASE = 'This order is now marked as paid on chain, but your wallet did not sign the release, so nothing was sent. Press Release USDC — sign to try again.'

function markedButNotReleased(reason: string) {
  return `This order is now marked as paid on chain, but the release did not complete here: ${reason.replace(/\.$/, '')}. Press Release USDC — sign to try again.`
}

function releaseNotConfirmed(button: string, maxTime: number | undefined) {
  const head =
    'Your release has not been confirmed yet. It may already have gone through, or may still: if so, this card changes to RELEASED by itself.'
  return maxTime
    ? `${head} If it still shows FIAT_PAID after ${retryAfter(maxTime)}, press ${button} again. The USDC cannot be sent twice.`
    : `${head} Pressing ${button} again cannot send the USDC twice.`
}

interface ConfirmReleaseSheetProps {
  order: Order
  open: boolean
  onClose: () => void
  onConfirmed: () => void
  onReceiptRecorded: () => void
  onOutcomeUnknown: (maxTime: number | undefined) => void

  submitFn?: SubmitFn
}

export function ConfirmReleaseSheet({
  order,
  open,
  onClose,
  onConfirmed,
  onReceiptRecorded,
  onOutcomeUnknown,
  submitFn = defaultSubmit,
}: ConfirmReleaseSheetProps) {
  const [checked, setChecked] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [errorUnknown, setErrorUnknown] = React.useState(false)
  const [receiptRecorded, setReceiptRecorded] = React.useState(false)
  const wallet = useWallet()
  const auth = useAuth()

  React.useEffect(() => {
    if (open) {
      setChecked(false)
      setError(null)
    }
  }, [open])

  const fiatDisplay = formatIDR(parseInt(order.fiat_amount, 10))
  const recordsReceiptFirst = order.status === 'FUNDED' && !receiptRecorded

  async function recordReceipt() {
    try {
      const { message, at } = await getConfirmReceiptMessage(client, order.id)
      const signature = await wallet.signMessage(message, auth.address ?? undefined)
      await confirmReceipt(client, order.id, { at, signature })
    } catch (err) {
      throw err instanceof Error ? err : new Error(DID_NOT_SIGN)
    }
  }

  async function handleConfirm() {
    setBusy(true)
    setError(null)
    setErrorUnknown(false)
    let recorded = receiptRecorded
    try {
      if (recordsReceiptFirst) {
        await recordReceipt()
        recorded = true
        setReceiptRecorded(true)
        onReceiptRecorded()
      }
      const { xdr, networkPassphrase } = await getConfirmReleaseTx(client, order.id)
      let signedXdr: string
      try {
        signedXdr = await wallet.signTransaction(xdr, networkPassphrase)
      } catch (err) {
        if (err instanceof Error) throw err
        setError(recorded ? MARKED_DID_NOT_SIGN_RELEASE : DID_NOT_SIGN_RELEASE)
        return
      }
      await submitFn(signedXdr, networkPassphrase)
      onConfirmed()
    } catch (err) {
      if (err instanceof OutcomeUnknown) {
        setError(
          `${recorded ? 'This order is now marked as paid on chain. ' : ''}${releaseNotConfirmed('Release USDC — sign', err.maxTime)}`,
        )
        setErrorUnknown(true)
        onOutcomeUnknown(err.maxTime)
      } else {
        const reason = err instanceof Error ? err.message : 'Release failed'
        setError(recorded ? markedButNotReleased(reason) : reason)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} ariaLabel="Confirm receipt & release" dismissible={!busy}>
      <h2 className="mb-4 font-geist text-lg font-bold text-lp-ink">Confirm receipt &amp; release</h2>

      {}
      <div className="mb-4 rounded-xl bg-lp-danger-soft p-3 text-sm text-lp-danger">
        <p className="mb-1 font-semibold">Warning</p>
        <p>
          Only release AFTER you&apos;ve received {fiatDisplay} in your {order.rail}{' '}
          account. Releasing without receiving funds loses your USDC.
        </p>
      </div>

      {}
      <div className="mb-4 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-lp-muted">Amount to receive</span>
          <span className="font-semibold text-lp-ink">{fiatDisplay}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-lp-muted">Via</span>
          <span className="font-semibold text-lp-ink">{order.rail}</span>
        </div>
        {order.ref && (
          <div className="flex items-center justify-between text-sm">
            <span className="text-lp-muted">Reference</span>
            <span className="font-semibold text-lp-ink">{order.ref}</span>
          </div>
        )}
      </div>

      {recordsReceiptFirst && (
        <div className="mb-4 text-sm text-lp-ink">
          <p>Your wallet will ask you to sign twice:</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5">
            <li>
              A statement that you received the full payment. Declining it records nothing. Signing it lets lolipay mark this order as paid on chain, and once it is marked that cannot be undone, even if you decline the second request: the USDC can then only be released, or settled through a dispute.
            </li>
            <li>The release, which sends the USDC to the buyer.</li>
          </ol>
        </div>
      )}

      {}
      <label className="mb-5 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          role="checkbox"
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-lp-accent"
        />
        <span className="text-sm text-lp-ink">
          I confirm I received {fiatDisplay} in my {order.rail} account.
        </span>
      </label>

      {error && (
        <p className={`mb-3 text-sm ${errorUnknown ? 'text-lp-ink' : 'text-lp-danger'}`} role="alert">
          {error}
        </p>
      )}

      <div className="space-y-2">
        <Button disabled={!checked || busy} loading={busy} onClick={handleConfirm}>
          {recordsReceiptFirst ? 'Confirm receipt & release — sign twice' : 'Release USDC — sign'}
        </Button>
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
      </div>
    </BottomSheet>
  )
}

interface AssignmentCardProps {
  assignment: Assignment
  onRefetch: () => void

  submitFn?: SubmitFn
}

export function AssignmentCard({
  assignment,
  onRefetch,
  submitFn = defaultSubmit,
}: AssignmentCardProps) {
  const { order } = assignment
  const wallet = useWallet()

  const [lockBusy, setLockBusy] = React.useState(false)
  const [lockError, setLockError] = React.useState<string | null>(null)
  const [lockUnknown, setLockUnknown] = React.useState(false)
  const [releaseOpen, setReleaseOpen] = React.useState(false)
  const [releaseSubmitted, setReleaseSubmitted] = React.useState(false)
  const [releaseUnconfirmed, setReleaseUnconfirmed] = React.useState<string | null>(null)
  const releaseConfirmedRef = React.useRef<HTMLParagraphElement>(null)
  const [paidBusy, setPaidBusy] = React.useState(false)
  const [paidError, setPaidError] = React.useState<string | null>(null)
  const [paidUnknown, setPaidUnknown] = React.useState(false)
  const [paidChecked, setPaidChecked] = React.useState(false)

  React.useEffect(() => {
    if (releaseSubmitted) releaseConfirmedRef.current?.focus()
  }, [releaseSubmitted])

  const [proofBusy, setProofBusy] = React.useState(false)
  const [proofError, setProofError] = React.useState<string | null>(null)

  const lpIsFiatPayer = order.flow !== 'TOP_UP'

  const [proofRrn, setProofRrn] = React.useState('')
  const [proofAmount, setProofAmount] = React.useState(() => String(parseInt(order.fiat_amount, 10)))
  const [proofPaidAt, setProofPaidAt] = React.useState('')

  const grossUsdc = BigInt(order.usdc_amount)
  const usdcDisplay = formatUSDC(lpIsFiatPayer ? grossUsdc - (grossUsdc * BigInt(order.platform_fee_bps)) / 10000n : grossUsdc)
  const fiatDisplay = formatIDR(parseInt(order.fiat_amount, 10))

  function copyRef(ref: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(ref)
    }
  }

  async function handleProofChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null
    e.target.value = ''
    if (!file) return
    if (!ACCEPTED_PROOF_TYPES.includes(file.type)) {
      setProofError('Unsupported file type — use JPG, PNG, WEBP, or PDF.')
      return
    }
    if (file.size > MAX_PROOF_BYTES) {
      setProofError('File too large — max 5MB.')
      return
    }

    const cleanRrn = proofRrn.replace(/[^A-Za-z0-9]/g, '')
    setProofError(null)
    setProofBusy(true)
    try {
      const meta = cleanRrn
        ? {
            rrn: cleanRrn,
            paidAmount: String(parseInt(proofAmount, 10)),
            paidAt: proofPaidAt ? new Date(proofPaidAt).toISOString() : new Date().toISOString(),
          }
        : undefined
      await uploadProof(client, order.id, file, meta)
      onRefetch()
    } catch (err) {
      setProofError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setProofBusy(false)
    }
  }

  async function handleLockUsdc() {
    setLockBusy(true)
    setLockError(null)
    try {
      const { xdr, networkPassphrase } = await getCreateTradeTx(client, order.id)
      const signedXdr = await wallet.signTransaction(xdr, networkPassphrase)
      await submitFn(signedXdr, networkPassphrase)
      onRefetch()
    } catch (err) {
      setLockError(err instanceof Error ? err.message : 'Lock failed')
      setLockUnknown(err instanceof OutcomeUnknown)
    } finally {
      setLockBusy(false)
    }
  }

  async function handleMarkPaid() {
    setPaidBusy(true)
    setPaidError(null)
    try {
      const { xdr, networkPassphrase } = await getMarkPaidTx(client, order.id)
      const signedXdr = await wallet.signTransaction(xdr, networkPassphrase)
      await submitFn(signedXdr, networkPassphrase)
      onRefetch()
    } catch (err) {
      setPaidError(err instanceof Error ? err.message : 'Mark-paid failed')
      setPaidUnknown(err instanceof OutcomeUnknown)
    } finally {
      setPaidBusy(false)
    }
  }

  const [disputeBusy, setDisputeBusy] = React.useState(false)
  const [disputeError, setDisputeError] = React.useState<{
    status: Order['status']
    text: string
    unknown: boolean
  } | null>(null)
  React.useEffect(() => setDisputeError(null), [order.status])
  async function handleDispute() {
    const pressedAt = order.status
    setDisputeBusy(true)
    setDisputeError(null)
    try {
      const { xdr, networkPassphrase } = await getRaiseDisputeTx(client, order.id)
      const signedXdr = await wallet.signTransaction(xdr, networkPassphrase)
      await submitFn(signedXdr, networkPassphrase)
      onRefetch()
    } catch (err) {
      setDisputeError({
        status: pressedAt,
        text: err instanceof Error ? err.message : 'Opening the dispute failed',
        unknown: err instanceof OutcomeUnknown,
      })
    } finally {
      setDisputeBusy(false)
    }
  }
  const nowMs = Date.now()
  const postSettleDeadlineMs = order.post_settle_dispute_until
    ? Date.parse(order.post_settle_dispute_until)
    : null
  const canPostSettleDispute =
    (order.status === 'RELEASED' || order.status === 'REFUNDED') &&
    postSettleDeadlineMs != null &&
    postSettleDeadlineMs > nowMs
  const windowOpen = Math.floor(nowMs / 1000) <= order.refund_opens_at
  const windowEnd = new Date(order.refund_opens_at * 1000).toLocaleString()

  const DisputeLink = (
    <div>
      <button
        type="button"
        className="w-full py-1 text-center text-xs text-lp-danger underline disabled:opacity-50"
        data-testid="lp-open-dispute"
        disabled={disputeBusy}
        onClick={handleDispute}
      >
        {disputeBusy ? 'Opening dispute…' : 'Open dispute'}
      </button>
      {disputeError?.status === order.status && (
        <p className={`mt-1 text-xs ${disputeError.unknown ? 'text-lp-ink' : 'text-lp-danger'}`} role="alert">
          {disputeError.text}
        </p>
      )}
    </div>
  )

  const releaseConfirmed = (className: string) => (
    <p ref={releaseConfirmedRef} tabIndex={-1} className={className} role="status">
      Release confirmed on the network: the USDC has been sent to the buyer. This card changes to RELEASED by itself.
    </p>
  )
  const releaseUnconfirmedId = `release-unconfirmed-${order.id}`

  return (
    <Card>
      {}
      <div className="mb-2 flex items-center justify-between">
        <p className="font-geist text-sm font-semibold text-lp-ink">
          {lpIsFiatPayer ? 'Receive' : 'Provide'} {usdcDisplay} USDC
        </p>
        <StatusPill tone={statusTone(order.status)}>{order.status}</StatusPill>
      </div>

      {}
      <p className="mb-1 text-sm text-lp-muted">
        {lpIsFiatPayer ? 'You pay' : 'You receive'} {fiatDisplay} via {order.rail}
      </p>
      <p className="mb-1 text-xs text-lp-muted">Rate: {formatIDR(Number(order.rate_snapshot))}</p>
      {}
      {order.user_address && (
        <p className="mb-3 text-xs text-lp-muted">
          {lpIsFiatPayer ? 'Seller' : 'Buyer'}: {truncate(order.user_address)}
        </p>
      )}

      {}
      {}
      {!lpIsFiatPayer && LOCK_STATUSES.includes(order.status) && (
        <div>
          <Button loading={lockBusy} disabled={lockBusy} onClick={handleLockUsdc}>
            Lock USDC
          </Button>
          {lockError && (
            <p className={`mt-2 text-xs ${lockUnknown ? 'text-lp-ink' : 'text-lp-danger'}`} role="alert">
              {lockError}
            </p>
          )}
        </div>
      )}

      {!lpIsFiatPayer && order.status === 'FUNDED' && (
        <div className="space-y-2">
          {releaseSubmitted ? (
            releaseConfirmed('text-sm text-lp-ink')
          ) : (
            <p className="text-sm text-lp-ink">
              {windowOpen
                ? `Check that ${fiatDisplay} has arrived in your ${order.rail} account. If it has, press Confirm receipt & release and approve both requests in your wallet: that records the payment on chain and releases the USDC to the buyer. Do it before ${windowEnd}; after that it can no longer be confirmed, and the USDC can be returned to you.`
                : `The time to confirm this payment ended at ${windowEnd}. It can no longer be confirmed, and the USDC can be returned to you.`}
            </p>
          )}
          {order.ref && (
            <div className="rounded-xl border border-lp-accent/30 bg-lp-accent-soft p-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-lp-ink-soft">
                Buyer must include this reference
              </p>
              <button
                type="button"
                data-testid="lp-transfer-ref"
                aria-label="Copy transfer reference"
                onClick={() => copyRef(order.ref!)}
                className="font-geist-mono text-sm font-bold text-lp-accent-ink"
              >
                {order.ref}
              </button>
            </div>
          )}
          {windowOpen && !releaseSubmitted && (
            <Button onClick={() => setReleaseOpen(true)}>
              Confirm receipt &amp; release
            </Button>
          )}
        </div>
      )}

      {!lpIsFiatPayer && order.status === 'FIAT_PAID' && (
        <>
          {releaseSubmitted ? (
            releaseConfirmed('mb-2 text-sm text-lp-ink')
          ) : (
            <>
              {releaseUnconfirmed && (
                <p id={releaseUnconfirmedId} className="mb-2 text-sm text-lp-ink">
                  {releaseUnconfirmed}
                </p>
              )}
              <Button
                aria-describedby={releaseUnconfirmed ? releaseUnconfirmedId : undefined}
                onClick={() => setReleaseOpen(true)}
              >
                Confirm receipt &amp; release
              </Button>
            </>
          )}
          {DisputeLink}
        </>
      )}

      {!lpIsFiatPayer && (order.status === 'FUNDED' || order.status === 'FIAT_PAID') && (
        <ConfirmReleaseSheet
          order={order}
          open={releaseOpen}
          onClose={() => setReleaseOpen(false)}
          onConfirmed={() => {
            setReleaseOpen(false)
            setReleaseSubmitted(true)
            onRefetch()
          }}
          onReceiptRecorded={onRefetch}
          onOutcomeUnknown={(maxTime) =>
            setReleaseUnconfirmed(releaseNotConfirmed('Confirm receipt & release', maxTime))
          }
          submitFn={submitFn}
        />
      )}

      {}
      {lpIsFiatPayer && LOCK_STATUSES.includes(order.status) && (
        <p className="text-sm italic text-lp-muted">Waiting for seller to lock USDC</p>
      )}

      {lpIsFiatPayer && order.status === 'FUNDED' && (
        <div className="space-y-3">
          <div className="rounded-xl border border-lp-accent/30 bg-lp-accent-soft p-3">
            <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-lp-ink-soft">
              Pay {fiatDisplay} to
            </p>
            <p className="break-all text-sm font-bold text-lp-accent-ink">
              {order.payment_instructions ?? (order.payment_instructions_withheld === 'kyc_required' ? 'Withheld until the customer finishes identity verification; the account appears here as soon as it is complete.' : '—')}
            </p>
          </div>
          {}
          <div className="rounded-xl bg-lp-danger-soft p-3 text-sm text-lp-danger">
            Only mark as paid AFTER you have actually sent {fiatDisplay} to the
            seller. This lets them release your USDC.
          </div>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="checkbox"
              role="checkbox"
              checked={paidChecked}
              onChange={(e) => setPaidChecked(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-lp-accent"
            />
            <span className="text-sm text-lp-ink">
              I confirm I sent {fiatDisplay} to the account above.
            </span>
          </label>

          {}
          {order.proof_url ? (
            <p className="text-xs font-semibold text-lp-accent-ink" data-testid="proof-uploaded">
              ✓ Transfer receipt uploaded
            </p>
          ) : (
            <div className="space-y-2">
              {}
              {(
                <div className="space-y-2 rounded-xl border border-lp-ink/10 bg-white p-3">
                  <div>
                    <label
                      htmlFor={`rrn-${order.id}`}
                      className="mb-1 block text-xs font-semibold text-lp-muted"
                    >
                      No. referensi / RRN (dari struk)
                    </label>
                    <input
                      id={`rrn-${order.id}`}
                      data-testid="proof-rrn-input"
                      type="text"
                      inputMode="text"
                      autoCapitalize="characters"
                      value={proofRrn}
                      onChange={(e) => setProofRrn(e.target.value)}
                      placeholder="mis. 123456789012"
                      disabled={proofBusy}
                      className="w-full rounded-lg border border-lp-ink/15 px-2 py-1.5 text-sm text-lp-ink"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`paid-amt-${order.id}`}
                      className="mb-1 block text-xs font-semibold text-lp-muted"
                    >
                      Nominal dibayar (Rp)
                    </label>
                    <input
                      id={`paid-amt-${order.id}`}
                      data-testid="proof-amount-input"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      value={proofAmount}
                      onChange={(e) => setProofAmount(e.target.value)}
                      disabled={proofBusy}
                      className="w-full rounded-lg border border-lp-ink/15 px-2 py-1.5 text-sm text-lp-ink"
                    />
                  </div>
                  <div>
                    <label
                      htmlFor={`paid-at-${order.id}`}
                      className="mb-1 block text-xs font-semibold text-lp-muted"
                    >
                      Waktu pembayaran
                    </label>
                    <input
                      id={`paid-at-${order.id}`}
                      data-testid="proof-paidat-input"
                      type="datetime-local"
                      value={proofPaidAt}
                      onChange={(e) => setProofPaidAt(e.target.value)}
                      disabled={proofBusy}
                      className="w-full rounded-lg border border-lp-ink/15 px-2 py-1.5 text-sm text-lp-ink"
                    />
                    <p className="mt-1 text-[11px] text-lp-muted">Kosongkan untuk pakai waktu sekarang.</p>
                  </div>
                </div>
              )}
              <label
                htmlFor={`proof-${order.id}`}
                className="mb-1 block text-xs font-semibold text-lp-muted"
              >
                Transfer receipt
              </label>
              <input
                id={`proof-${order.id}`}
                data-testid="proof-upload-input"
                type="file"
                accept="image/jpeg,image/png,image/webp,application/pdf"
                onChange={handleProofChange}
                disabled={proofBusy}
                className="w-full text-xs text-lp-muted"
              />
              {proofBusy && <p className="mt-1 text-xs text-lp-muted">Uploading…</p>}
            </div>
          )}
          {proofError && (
            <p className="text-xs text-lp-danger" role="alert">
              {proofError}
            </p>
          )}

          {paidError && (
            <p className={`text-xs ${paidUnknown ? 'text-lp-ink' : 'text-lp-danger'}`} role="alert">
              {paidError}
            </p>
          )}
          <Button
            loading={paidBusy}
            disabled={
              !paidChecked ||
              paidBusy ||
              (!!assignment.require_proof && !order.proof_url)
            }
            onClick={handleMarkPaid}
          >
            Mark fiat paid — sign
          </Button>
          {assignment.require_proof && !order.proof_url && (
            <p className="text-xs text-lp-muted" data-testid="proof-required-hint">
              Upload your transfer receipt first
            </p>
          )}
        </div>
      )}

      {lpIsFiatPayer && order.status === 'FIAT_PAID' && (
        <div className="space-y-1">
          <p className="text-sm italic text-lp-muted">
            Waiting for seller to confirm &amp; release your USDC
          </p>
          {DisputeLink}
        </div>
      )}

      {}
      {TERMINAL_STATUSES.includes(order.status) && (
        <p className="text-xs text-lp-muted">Completed</p>
      )}
      {canPostSettleDispute && DisputeLink}
    </Card>
  )
}

export default function AssignmentsPage() {
  const qc = useQueryClient()

  const {
    data: assignments,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['assignments'],
    queryFn: () => getAssignments(client),
    refetchInterval: 7_000,
  })

  function refetch() {
    qc.invalidateQueries({ queryKey: ['assignments'] })
  }

  useRealtimeChannel({
    onAssignmentsChanged: refetch,
  })

  return (
    <div className={`flex min-h-screen flex-col bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader title="Assignments" />
      <main className="flex-1 px-[18px] pt-1">
        {isLoading && (
          <p className="py-8 text-center text-sm text-lp-muted">Loading assignments…</p>
        )}

        {isError && (
          <p className="py-8 text-center text-sm text-lp-danger" role="alert">
            Failed to load assignments
          </p>
        )}

        {assignments && assignments.length === 0 && (
          <p className="py-8 text-center text-sm text-lp-muted">
            No assignments yet — stake the minimum, add a payment method for your rail, and go online to receive orders.
          </p>
        )}

        {assignments && assignments.length > 0 && (
          <div className="space-y-4">
            {assignments.map((a) => (
              <AssignmentCard
                key={a.order.id}
                assignment={a}
                onRefetch={refetch}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
