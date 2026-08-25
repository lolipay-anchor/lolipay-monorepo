'use client'

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, TransactionBuilder } from '@stellar/stellar-sdk'
import { getAdminOrders, getResolveTx, getSlashTx, getSlashState, downloadOrderProof, downloadDisputeEvidence, getAdminOrderRisk } from '@lolipay/api-client'
import type { Order, OrderStatus } from '@lolipay/api-client'
import { useWallet } from '@lolipay/wallet'
import { Card, StatusPill, Button, SegmentProgress, NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { AppHeader } from '@/components/AppHeader'
import { client } from '@/lib/client'
import { formatIDR, formatUSDC } from '@/lib/money'
import { useRealtimeChannel } from '@/hooks/useRealtimeChannel'

export type SubmitFn = (signedXdr: string, networkPassphrase: string) => Promise<unknown>

async function defaultSubmit(signedXdr: string, networkPassphrase: string) {
  const server = new rpc.Server(
    process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  )
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase)
  const res = await server.sendTransaction(tx)
  if (res.status !== 'PENDING') throw new Error(`Submission failed (${res.status})`)
  return res
}

export function ResolveActions({
  order,
  onResolved,
  submitFn = defaultSubmit,
}: {
  order: Order
  onResolved: () => void
  submitFn?: SubmitFn
}) {
  const wallet = useWallet()
  const [busy, setBusy] = React.useState<null | 'release' | 'refund'>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function resolve(outcome: 'release' | 'refund') {
    setBusy(outcome)
    setError(null)
    try {
      const { xdr, networkPassphrase } = await getResolveTx(client, order.id, outcome)
      const signedXdr = await wallet.signTransaction(xdr, networkPassphrase)
      await submitFn(signedXdr, networkPassphrase)
      onResolved()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Resolve failed')
    } finally {
      setBusy(null)
    }
  }

  const isTopUp = order.flow === 'TOP_UP'
  const releaseLabel = isTopUp ? 'Release to user' : 'Release to LP'
  const refundLabel = isTopUp ? 'Refund to LP' : 'Refund to user'

  return (
    <div className="mt-3 border-t border-lp-line pt-3 space-y-2">
      <p className="text-xs font-semibold text-lp-amber">Resolve dispute</p>
      {error && (
        <p className="text-xs text-lp-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          className="flex-1"
          loading={busy === 'release'}
          disabled={!!busy}
          onClick={() => resolve('release')}
          data-testid="resolve-release"
          aria-label={releaseLabel}
        >
          {releaseLabel}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="flex-1"
          loading={busy === 'refund'}
          disabled={!!busy}
          onClick={() => resolve('refund')}
          data-testid="resolve-refund"
          aria-label={refundLabel}
        >
          {refundLabel}
        </Button>
      </div>
      {}
      <p className="text-[11px] leading-relaxed text-lp-muted">
        Resolve first. Resolving is what establishes the liability a slash requires, so a slash is
        submitted after this, never before. Once liability exists a further dispute can extend the
        deadline but no longer blocks recovery. A recovery panel appears on settlements where the
        provider is the one that defaulted.
      </p>
    </div>
  )
}

const DISPUTE_REASON_LABELS: Record<string, string> = {
  USDC_NOT_RELEASED: 'USDC not released',
  PAID_WRONG_AMOUNT: 'Paid the wrong amount',
  PAYMENT_NOT_RECEIVED: 'Payment not received',
  WRONG_AMOUNT: 'Wrong amount',
  FAKE_PROOF: 'Proof looks fake',
  OTHER: 'Other',
}

function humanizeDisputeReason(reason?: string | null): string {
  if (!reason) return 'Not specified'
  return DISPUTE_REASON_LABELS[reason] ?? reason
}

function extFromPath(p: string | null | undefined): string {
  if (!p) return 'bin'
  const parts = p.split('.')
  return parts.length > 1 ? parts[parts.length - 1] : 'bin'
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function DownloadButton({
  label,
  testId,
  filename,
  onDownload,
}: {
  label: string
  testId: string
  filename: string
  onDownload: () => Promise<Blob>
}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function handleClick() {
    setBusy(true)
    setError(null)
    try {
      const blob = await onDownload()
      triggerDownload(blob, filename)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <button
        type="button"
        data-testid={testId}
        onClick={handleClick}
        disabled={busy}
        className="text-xs font-semibold text-lp-accent-ink underline disabled:opacity-50"
      >
        {busy ? 'Downloading…' : label}
      </button>
      {error && (
        <p className="text-xs text-lp-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

type RiskTone = 'danger' | 'muted'
const riskToneClasses: Record<RiskTone, string> = {
  danger: 'text-lp-danger bg-lp-danger-soft',
  muted: 'text-lp-ink-soft bg-lp-line-2',
}

function RiskChip({
  tone,
  testId,
  children,
}: {
  tone: RiskTone
  testId: string
  children: React.ReactNode
}) {
  return (
    <span
      data-testid={testId}
      className={`text-[10px] font-semibold uppercase tracking-wide rounded-full px-2 py-0.5 ${riskToneClasses[tone]}`}
    >
      {children}
    </span>
  )
}

function RiskChips({ orderId }: { orderId: string }) {
  const { data: risk, isLoading, error } = useQuery({
    queryKey: ['adminOrderRisk', orderId],
    queryFn: () => getAdminOrderRisk(client, orderId),
  })

  if (isLoading) {
    return (
      <p className="text-xs text-lp-muted" data-testid="risk-loading">
        Loading risk signals…
      </p>
    )
  }

  if (error || !risk) {
    return (
      <p className="text-xs text-lp-danger" data-testid="risk-error">
        Failed to load risk signals.
      </p>
    )
  }

  const walletAgeUnknown = risk.wallet_age_days === null
  const ratio = risk.amount_vs_tier_limit.ratio
  const ratioHigh = ratio != null && ratio > 1

  return (
    <div className="flex flex-wrap gap-1.5" data-testid="risk-chips">
      <RiskChip tone={walletAgeUnknown ? 'danger' : 'muted'} testId="risk-wallet-age">
        {walletAgeUnknown
          ? 'Wallet age unknown — treat as high risk'
          : `Wallet age: ${risk.wallet_age_days}d`}
      </RiskChip>
      <RiskChip
        tone={risk.user_dispute_velocity_30d > 0 ? 'danger' : 'muted'}
        testId="risk-user-disputes"
      >
        User disputes (30d): {risk.user_dispute_velocity_30d}
      </RiskChip>
      <RiskChip
        tone={risk.lp_dispute_velocity_30d > 0 ? 'danger' : 'muted'}
        testId="risk-lp-disputes"
      >
        LP disputes (30d): {risk.lp_dispute_velocity_30d}
      </RiskChip>
      <RiskChip tone={ratioHigh ? 'danger' : 'muted'} testId="risk-amount-vs-limit">
        {ratio != null ? `${ratio.toFixed(2)}× daily limit (${risk.amount_vs_tier_limit.tier})` : 'Amount vs limit: —'}
      </RiskChip>
      {risk.lp_completion && (
        <RiskChip tone="muted" testId="risk-lp-completion">
          LP: {risk.lp_completion.completed_trades} trades
          {risk.lp_completion.completion_rate != null
            ? ` · ${Math.round(risk.lp_completion.completion_rate * 100)}%`
            : ''}
        </RiskChip>
      )}
    </div>
  )
}

function hasOpenDisputeSignal(order: Order): boolean {
  if (!order.dispute_by) return false
  if (!order.resolution) return true
  return !!(
    order.dispute_at &&
    order.settled_at &&
    new Date(order.dispute_at).getTime() > new Date(order.settled_at).getTime()
  )
}

function DisputePanel({ order }: { order: Order }) {
  const isPostSettlement = !!order.settled_at

  const awaitingOnchain = order.status !== 'DISPUTED'

  return (
    <div className="mt-3 border-t border-lp-line pt-3 space-y-1.5" data-testid="dispute-panel">
      <div className="flex items-center gap-2 flex-wrap">
        <p className="text-xs font-semibold uppercase tracking-wide text-lp-danger">Open dispute</p>
        {order.dispute_at && (
          <span className="text-[11px] text-lp-muted">
            opened {new Date(order.dispute_at).toLocaleString()}
          </span>
        )}
        {awaitingOnchain && (
          <span
            className="text-[10px] font-semibold uppercase tracking-wide text-lp-amber bg-lp-amber/10 rounded-full px-2 py-0.5"
            data-testid="awaiting-onchain-badge"
          >
            Filed — awaiting on-chain
          </span>
        )}
        {isPostSettlement && (
          <span
            className="text-[10px] font-semibold uppercase tracking-wide text-lp-danger bg-lp-danger-soft rounded-full px-2 py-0.5"
            data-testid="post-settlement-badge"
          >
            Post-settlement dispute
          </span>
        )}
      </div>
      {awaitingOnchain && (
        <p className="text-[11px] leading-relaxed text-lp-muted">
          The filer hasn&apos;t signed the on-chain raise_dispute yet — resolve unlocks once it lands.
        </p>
      )}
      <p className="text-xs text-lp-muted">
        <span className="font-semibold">Filed by:</span> {order.dispute_by ?? '—'}
      </p>
      <p className="text-xs text-lp-muted">
        <span className="font-semibold">Reason:</span> {humanizeDisputeReason(order.dispute_reason)}
      </p>
      {order.dispute_note && (
        <p className="text-xs text-lp-muted">
          <span className="font-semibold">Note:</span> {order.dispute_note}
        </p>
      )}
      {order.dispute_evidence_url && (
        <DownloadButton
          label="Download evidence"
          testId="download-evidence"
          filename={`evidence-${order.id}.${extFromPath(order.dispute_evidence_url)}`}
          onDownload={() => downloadDisputeEvidence(client, order.id)}
        />
      )}
      {order.flow === 'WITHDRAW' && <PaymentProofCrossCheck order={order} />}
      <RiskChips orderId={order.id} />
    </div>
  )
}

function PaymentProofCrossCheck({ order }: { order: Order }) {
  const billAmount = parseInt(order.fiat_amount, 10)
  const paidAmount = order.proof_amount != null ? parseInt(order.proof_amount, 10) : null

  const amountMismatch =
    order.proof_amount != null && BigInt(order.proof_amount) !== BigInt(order.fiat_amount)

  return (
    <div
      className="mt-2 rounded-lg border border-lp-line bg-lp-line/10 p-2.5 space-y-2"
      data-testid="proof-crosscheck"
    >
      <p className="text-xs font-semibold text-lp-amber">Payment cross-check</p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-0.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-lp-muted">Order</p>
          <p className="text-xs text-lp-ink">
            <span className="text-lp-muted">Bill:</span> {formatIDR(billAmount)}
          </p>
        </div>
        <div className="space-y-0.5">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-lp-muted">LP payment proof</p>
          <p className="text-xs text-lp-ink break-all">
            <span className="text-lp-muted">RRN:</span> {order.proof_rrn ?? '—'}
          </p>
          <p className={`text-xs ${amountMismatch ? 'font-semibold text-lp-danger' : 'text-lp-ink'}`}>
            <span className="text-lp-muted">Paid:</span>{' '}
            {paidAmount != null ? formatIDR(paidAmount) : '—'}
            {amountMismatch && ' ⚠ mismatch'}
          </p>
          <p className="text-xs text-lp-ink">
            <span className="text-lp-muted">At:</span>{' '}
            {order.proof_paid_at ? new Date(order.proof_paid_at).toLocaleString() : '—'}
          </p>
        </div>
      </div>
      {order.proof_url && (
        <DownloadButton
          label="Download receipt"
          testId="download-receipt"
          filename={`receipt-${order.id}.${extFromPath(order.proof_url)}`}
          onDownload={() => downloadOrderProof(client, order.id)}
        />
      )}
    </div>
  )
}

type FilterChip = 'ALL' | OrderStatus

const FILTERS: FilterChip[] = [
  'ALL',
  'CREATED',
  'MATCHED',
  'AWAITING_ONCHAIN',
  'FUNDED',
  'FIAT_PAID',
  'RELEASED',
  'DISPUTED',
  'EXPIRED',
  'CANCELLED',
  'REFUNDED',
]

function statusTone(s: OrderStatus): 'amber' | 'green' | 'neutral' {
  if (s === 'RELEASED') return 'green'
  if (s === 'DISPUTED' || s === 'FIAT_PAID' || s === 'FUNDED') return 'amber'
  return 'neutral'
}

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

const TIMELINE_LABELS = ['Order created', 'Escrow locked', 'Fiat settled', 'Released'] as const

function timelineStepsDone(status: OrderStatus): number {
  switch (status) {
    case 'CREATED':
    case 'MATCHED':
    case 'AWAITING_ONCHAIN':
      return 1
    case 'FUNDED':
      return 2
    case 'FIAT_PAID':
    case 'DISPUTED':
      return 3
    case 'RELEASED':
    case 'REFUNDED':
      return 4
    default:
      return 1
  }
}

function OrderTimeline({ order }: { order: Order }) {
  const done = timelineStepsDone(order.status)
  return (
    <div className="mt-3 space-y-2" data-testid="order-timeline">
      <SegmentProgress total={4} done={done} />
      <ul className="flex flex-col gap-1">
        {TIMELINE_LABELS.map((label, i) => (
          <li
            key={label}
            className={`text-[11.5px] ${i < done ? 'text-lp-ink' : 'text-lp-faint'}`}
          >
            {label}
          </li>
        ))}
      </ul>
    </div>
  )
}

function OrderCard({ order, onResolved }: { order: Order; onResolved: () => void }) {
  const [showTimeline, setShowTimeline] = React.useState(false)

  return (
    <Card>
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-geist text-sm font-semibold text-lp-ink">
            {formatUSDC(BigInt(order.usdc_amount))} USDC
          </p>
          <p className="text-xs text-lp-muted mt-0.5">
            {formatIDR(parseInt(order.fiat_amount, 10))}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {order.status !== 'RELEASED' && order.status !== 'REFUNDED' && order.status !== 'CANCELLED' && order.status !== 'EXPIRED' && (
            <span
              data-testid="live-chip"
              className="inline-flex items-center gap-1 rounded-lp-pill bg-lp-green-soft px-2 py-1 text-[10px] font-bold text-lp-green"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-lp-green" />
              LIVE
            </span>
          )}
          <StatusPill tone={statusTone(order.status)}>{order.status}</StatusPill>
        </div>
      </div>

      <div className="mt-2 space-y-0.5 text-xs text-lp-muted">
        <p>
          <span className="font-semibold text-lp-ink-soft">Rate:</span> {order.rate_snapshot}
        </p>
        <p>
          <span className="font-semibold text-lp-ink-soft">Flow:</span> {order.flow} &nbsp;
          <span className="font-semibold text-lp-ink-soft">Rail:</span> {order.rail}
        </p>
        <p>
          <span className="font-semibold text-lp-ink-soft">User:</span>{' '}
          <span className="font-geist-mono">{order.user_address ? truncateAddress(order.user_address) : '—'}</span>
        </p>
        <p>
          <span className="font-semibold text-lp-ink-soft">LP:</span>{' '}
          <span className="font-geist-mono">{order.lp_wallet ? truncateAddress(order.lp_wallet) : '—'}</span>
        </p>
        <p>
          <span className="font-semibold text-lp-ink-soft">Created:</span>{' '}
          {new Date(order.created_at).toLocaleString()}
        </p>
        {order.ref && (
          <p>
            <span className="font-semibold text-lp-ink-soft">Ref:</span>{' '}
            <span className="font-geist-mono" data-testid="order-ref">{order.ref}</span>
          </p>
        )}
      </div>

      {order.proof_url && (
        <div className="mt-2">
          <DownloadButton
            label="Download proof"
            testId="download-proof"
            filename={`proof-${order.id}.${extFromPath(order.proof_url)}`}
            onDownload={() => downloadOrderProof(client, order.id)}
          />
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowTimeline((v) => !v)}
        data-testid="toggle-timeline"
        className="mt-3 w-full rounded-lp-tile border border-lp-line bg-lp-raise py-2 text-xs font-semibold text-lp-ink-soft"
      >
        {showTimeline ? 'Hide timeline' : 'Show timeline'}
      </button>
      {showTimeline && <OrderTimeline order={order} />}

      {}
      {(order.status === 'DISPUTED' || hasOpenDisputeSignal(order)) && <DisputePanel order={order} />}

      {order.status === 'DISPUTED' && (
        <ResolveActions order={order} onResolved={onResolved} />
      )}

      {providerDefaulted(order) && <SlashAction order={order} onSlashed={onResolved} />}
    </Card>
  )
}

export function providerDefaulted(order: Order): boolean {
  const settledAgainstProvider =
    (order.flow === 'TOP_UP' && order.status === 'REFUNDED') ||
    (order.flow === 'WITHDRAW' && order.status === 'RELEASED')
  const stillBeingJudged = order.status === 'DISPUTED' && !!order.settled_at
  if (!settledAgainstProvider && !stillBeingJudged) return false
  return !!(
    order.dispute_at &&
    order.settled_at &&
    new Date(order.dispute_at).getTime() > new Date(order.settled_at).getTime()
  )
}

export function SlashAction({
  order,
  onSlashed,
  submitFn = defaultSubmit,
}: {
  order: Order
  onSlashed: () => void
  submitFn?: SubmitFn
}) {
  const wallet = useWallet()
  const full = order.usdc_amount
  const [amount, setAmount] = React.useState(full)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [state, setState] = React.useState<{ recovered: string; remaining: string } | null>(null)

  const load = React.useCallback(async () => {
    try {
      const st = await getSlashState(client, order.id)
      setState({ recovered: st.recovered, remaining: st.remaining })
      setAmount(st.remaining)
    } catch {
      setState(null)
    }
  }, [order.id])

  React.useEffect(() => {
    void load()
  }, [load])

  async function slash() {
    setBusy(true)
    setError(null)
    try {
      const { xdr, networkPassphrase } = await getSlashTx(client, order.id, amount)
      const signedXdr = await wallet.signTransaction(xdr, networkPassphrase)
      await submitFn(signedXdr, networkPassphrase)
      await load()
      onSlashed()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Slash failed')
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 border-t border-lp-line pt-3 space-y-2">
      <p className="text-xs font-semibold text-lp-amber">Recover from the provider&apos;s bond</p>
      {error && (
        <p className="text-xs text-lp-danger" role="alert">
          {error}
        </p>
      )}
      <div className="flex gap-2 items-center">
        <input
          type="text"
          inputMode="numeric"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
          disabled={busy}
          aria-label="Amount to recover, in USDC base units"
          data-testid="slash-amount"
          className="flex-1 rounded bg-lp-surface border border-lp-line px-2 py-1 text-xs text-lp-text"
        />
        <Button
          size="sm"
          loading={busy}
          disabled={busy || amount === '' || amount === '0'}
          onClick={slash}
          data-testid="slash-submit"
          aria-label="Recover from bond"
        >
          Recover
        </Button>
      </div>
      <p className="text-[11px] leading-relaxed text-lp-muted" data-testid="slash-state">
        {state
          ? `${formatUSDC(BigInt(state.recovered))} of ${formatUSDC(BigInt(full))} USDC already recovered on this trade; ${formatUSDC(BigInt(state.remaining))} left.`
          : `Up to ${formatUSDC(BigInt(full))} USDC on this trade.`}{' '}
        Pays the counterparty out of the provider&apos;s staked collateral. Partial recovery is
        allowed and may be repeated, but the total can never exceed the trade value — check the
        figure above before signing, because a repeated submission recovers twice. Requires the
        resolver or administrator key, and only works after the dispute has been resolved.
      </p>
    </div>
  )
}

function OrdersList() {
  const searchParams = useSearchParams()
  const initialFilter = React.useMemo<FilterChip>(() => {
    const s = searchParams?.get('status')
    return s && (FILTERS as string[]).includes(s) ? (s as FilterChip) : 'ALL'
  }, [searchParams])
  const [filter, setFilter] = React.useState<FilterChip>(initialFilter)

  const statusParam = filter === 'ALL' || filter === 'DISPUTED' ? undefined : (filter as OrderStatus)
  const qc = useQueryClient()

  const { data: rawOrders, isLoading, error } = useQuery({
    queryKey: ['adminOrders', filter],
    queryFn: () => getAdminOrders(client, statusParam),
  })
  const orders = React.useMemo(
    () =>
      filter === 'DISPUTED'
        ? rawOrders?.filter((o) => o.status === 'DISPUTED' || hasOpenDisputeSignal(o))
        : rawOrders,
    [rawOrders, filter],
  )

  useRealtimeChannel({
    onOrderUpdate: () => {
      qc.invalidateQueries({ queryKey: ['adminOrders'] })
    },
  })

  return (
    <div>
      {}
      <div className="flex gap-2 overflow-x-auto pb-1 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lp-pill border transition ${
              filter === f
                ? 'bg-lp-ink text-white border-lp-ink'
                : 'bg-lp-surface text-lp-muted border-lp-line hover:border-lp-accent'
            }`}
          >
            {f === 'ALL' ? 'All' : f}
          </button>
        ))}
      </div>

      {isLoading && (
        <p className="text-lp-muted text-sm text-center py-8">Loading…</p>
      )}

      {error && !isLoading && (
        <p className="text-lp-danger text-sm text-center py-8">
          Failed to load orders. Please try again.
        </p>
      )}

      {!isLoading && !error && orders && orders.length === 0 && (
        <p className="text-lp-muted text-sm text-center py-8">No orders found.</p>
      )}

      {!isLoading && !error && orders && orders.length > 0 && (
        <ul className="space-y-3">
          {orders.map((o) => (
            <li key={o.id}>
              <OrderCard
                order={o}
                onResolved={() => qc.invalidateQueries({ queryKey: ['adminOrders'] })}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function OrdersPage() {
  return (
    <div className={`flex flex-col min-h-screen bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader title="Orders" />
      <main className="flex-1 px-[18px] pt-1">
        {}
        <React.Suspense fallback={null}>
          <OrdersList />
        </React.Suspense>
      </main>
    </div>
  )
}
