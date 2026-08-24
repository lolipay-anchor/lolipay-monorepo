'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  Copy,
  Handshake,
  Loader2,
  ShieldAlert,
  Undo2,
} from 'lucide-react'
import {
  getOrder,
  getCreateTradeTx,
  getConfirmReleaseTx,
  cancelOrder,
} from '@lolipay/api-client'
import { DarkHeroCard, StatusPill, Stepper, Countdown, HoldToRelease, SkeletonList } from '@lolipay/ui'
import { client } from '@/lib/client'
import { formatIDR, formatUSDC } from '@/lib/money'
import { stepsFor, isTerminal } from '@/lib/steps'
import type { OrderStatus as OrderStatusType, Flow } from '@lolipay/api-client'
import { pillFor } from '@/lib/format'
import { IvePaidSheet } from '@/components/IvePaidSheet'
import { EscrowLocked } from '@/components/EscrowLocked'
import { LpReputationCard } from '@/components/LpReputationCard'
import { TrustlineNotice } from '@/components/TrustlineNotice'
import { DisputeForm } from '@/components/DisputeForm'
import { useSignOrderTx, type SubmitFn } from '@/hooks/useSignOrderTx'
import { useRealtimeChannel } from '@/hooks/useRealtimeChannel'
import { useToast } from '@/components/Toast'

function activeCountdown(order: {
  status: OrderStatusType
  flow: string
  pay_deadline: number
  confirm_deadline: number
  expires_at: string
}): { deadline: number; label: string } | null {
  const lpPaysFiat = order.flow !== 'TOP_UP'
  switch (order.status) {
    case 'MATCHED':
    case 'AWAITING_ONCHAIN':

      return { deadline: Math.floor(new Date(order.expires_at).getTime() / 1000), label: 'Lock within' }
    case 'FUNDED':

      return {
        deadline: lpPaysFiat ? order.confirm_deadline : order.pay_deadline,
        label: lpPaysFiat ? 'Merchant pays within' : 'Pay within',
      }
    case 'FIAT_PAID':

      return {
        deadline: order.confirm_deadline,
        label: lpPaysFiat ? 'Confirm receipt within' : 'Merchant releases within',
      }
    default:
      return null
  }
}

function releasedTitle(flow: Flow): string {
  return flow === 'TOP_UP' ? 'USDC delivered ✓' : 'Payment complete'
}

function caseId(orderId: string): string {
  return '#' + orderId.slice(-6).toUpperCase()
}

interface Props {
  id: string

  submitFn?: SubmitFn
}

export function OrderStatus({ id, submitFn }: Props) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const toast = useToast()
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [disputeOpen, setDisputeOpen] = React.useState(false)

  const lockTx = useSignOrderTx(getCreateTradeTx, submitFn)
  const releaseTx = useSignOrderTx(getConfirmReleaseTx, submitFn)
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['order', id] })
  const goToOrders = () => router.push('/orders')

  useRealtimeChannel({
    orderIds: [id],
    onOrderUpdate: (payload) => {
      if (payload.id === id) invalidate()
    },
  })

  const cancelMut = useMutation({
    mutationFn: () => cancelOrder(client, id),
    onSuccess: () => invalidate(),
  })

  const copyRef = async (ref: string) => {
    await navigator.clipboard.writeText(ref)
    toast('Reference copied', 'success')
  }

  const { data: order, isLoading, error } = useQuery({
    queryKey: ['order', id],
    queryFn: () => getOrder(client, id),
    refetchInterval: (q) => {
      const status = q.state?.data?.status
      if (!status || isTerminal(status)) return false
      return 5000
    },
  })

  if (isLoading) {
    return (
      <div className="min-h-screen bg-lp-paper px-[18px] pt-4">
        <SkeletonList rows={3} />
      </div>
    )
  }

  if (error || !order) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-lp-paper">
        <p className="text-sm text-lp-muted">
          {error instanceof Error ? error.message : 'Failed to load order.'}
        </p>
      </div>
    )
  }

  const usdcAmount = formatUSDC(BigInt(order.usdc_amount))
  const fiatAmount = parseInt(order.fiat_amount, 10)

  const lpPaysFiat = order.flow !== 'TOP_UP'
  const steps = stepsFor(order.status, order.flow)
  const cd = activeCountdown(order)
  const pill = pillFor(order.status, order.flow)

  const postSettleDeadlineMs = order.post_settle_dispute_until
    ? Date.parse(order.post_settle_dispute_until)
    : null
  const canPostSettleDispute = postSettleDeadlineMs != null && postSettleDeadlineMs > Date.now()

  return (
    <div className="flex min-h-screen flex-col bg-lp-paper pb-28">
      <main className="flex flex-1 flex-col gap-3.5 px-[18px] pt-4 animate-lp-rise">
        {}
        <DarkHeroCard>
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-geist-mono text-[30px] font-bold leading-none tracking-[-0.02em] tabular-nums">
                {usdcAmount} <span className="text-base font-semibold opacity-60">USDC</span>
              </p>
              <p className="mt-[3px] text-[13px] opacity-60">
                {lpPaysFiat ? 'You receive' : 'You pay'}{' '}
                {formatIDR(fiatAmount)} · rate {order.rate_snapshot}
              </p>
            </div>
            <StatusPill tone={pill.tone} className="shrink-0">
              {pill.label}
            </StatusPill>
          </div>
        </DarkHeroCard>

        {}
        {order.lp_reputation && <LpReputationCard rep={order.lp_reputation} />}

        {}
        {!lpPaysFiat && !isTerminal(order.status) && <TrustlineNotice />}

        {}
        {cd && (
          <div className="flex items-center justify-between rounded-lp-card border border-lp-line bg-lp-surface px-4 py-[14px]">
            <span className="text-[13px] text-lp-muted">{cd.label}</span>
            <Countdown
              deadline={cd.deadline * 1000}
              onExpire={invalidate}
              className="text-[17px] font-bold"
            />
          </div>
        )}

        {}
        <EscrowLocked status={order.status} />

        {}
        <div className="rounded-lp-card border border-lp-line bg-lp-surface p-4">
          <Stepper
            steps={steps.map((s, i) => ({
              label: s.label,
              state: s.state,
              at: i === 0 ? new Date(order.created_at).toLocaleString('id-ID') : undefined,
            }))}
          />
        </div>

        {}
        {}
        {!lpPaysFiat && order.status === 'FUNDED' && (
          <div className="flex flex-col gap-3" data-testid="ive-paid-slot">
            {order.payment_instructions && (
              <div className="rounded-lp-card border border-lp-line bg-lp-surface p-4">
                <p className="mb-1 font-geist-mono text-[11px] uppercase tracking-[.08em] text-lp-muted">
                  Transfer to
                </p>
                <p className="mb-1 text-[13.5px] font-semibold text-lp-ink">
                  Transfer {formatIDR(fiatAmount)} to
                </p>
                <p className="font-geist-mono text-[15px] font-bold text-lp-accent-ink">
                  {order.payment_instructions}
                </p>
                {order.ref && (
                  <>
                    <p className="mb-1 mt-3 text-[13.5px] font-semibold text-lp-ink">
                      Include this reference in your transfer note
                    </p>
                    <button
                      type="button"
                      data-testid="transfer-ref"
                      aria-label="Copy transfer reference"
                      onClick={() => copyRef(order.ref!)}
                      className="flex items-center gap-1.5 font-geist-mono text-[15px] font-bold text-lp-accent-ink"
                    >
                      {order.ref}
                      <Copy size={13} strokeWidth={1.9} className="opacity-70" aria-hidden="true" />
                    </button>
                  </>
                )}
              </div>
            )}

            <div className="flex items-start gap-2.5 rounded-[14px] bg-lp-amber-soft px-[14px] py-[12px]">
              <AlertTriangle size={17} strokeWidth={1.8} className="mt-0.5 flex-none text-lp-amber" aria-hidden="true" />
              <span className="text-xs leading-[1.45] text-lp-ink">
                Pay from a bank account in your own name — third-party transfers are rejected and
                auto-refunded.
              </span>
            </div>

            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="w-full rounded-lp-cta bg-lp-ink py-4 font-geist text-[15px] font-semibold text-lp-paper transition"
            >
              I&apos;ve paid
            </button>

            <IvePaidSheet
              order={order}
              open={sheetOpen}
              onClose={() => setSheetOpen(false)}
              onConfirmed={() => {
                setSheetOpen(false)
                invalidate()
              }}
            />
          </div>
        )}

        {!lpPaysFiat && order.status === 'FIAT_PAID' && (
          <div className="flex flex-col gap-2">
            <p className="text-center text-[13px] text-lp-muted">
              Payment confirmed — waiting for merchant to release
            </p>
            <button
              type="button"
              className="w-full py-1 text-center text-[13px] font-semibold text-lp-danger underline"
              data-testid="open-dispute"
              onClick={() => setDisputeOpen(true)}
            >
              Open dispute
            </button>
          </div>
        )}

        {}
        {lpPaysFiat &&
          (order.status === 'MATCHED' || order.status === 'AWAITING_ONCHAIN') && (
            <div className="flex flex-col gap-2.5 rounded-lp-card border border-lp-line bg-lp-surface p-4">
              <p className="text-center text-[13px] text-lp-muted">
                Lock your USDC in escrow to start the sale.
              </p>
              {lockTx.error && (
                <p className="text-center text-sm text-lp-danger" role="alert">
                  {lockTx.error.message}
                </p>
              )}
              <button
                type="button"
                disabled={lockTx.isPending}
                data-testid="lock-usdc"
                onClick={() => {
                  lockTx.submit(order.id).then(invalidate).catch(() => {})
                }}
                className="w-full rounded-lp-cta bg-lp-accent py-4 font-geist text-[15px] font-semibold text-white shadow-lp-cta transition disabled:cursor-not-allowed disabled:opacity-60"
              >
                {lockTx.isPending ? 'Locking…' : 'Lock USDC — sign'}
              </button>
            </div>
          )}

        {lpPaysFiat && order.status === 'FUNDED' && (
          <div className="flex flex-col gap-1.5 rounded-lp-card border border-lp-line bg-lp-surface p-4">
            <p className="text-center text-[13px] text-lp-muted">
              USDC locked. Waiting for the merchant to pay {formatIDR(fiatAmount)}{' '}
              to your bank…
            </p>
            <p className="text-center text-[11.5px] text-lp-faint">
              If the timer runs out unpaid, your USDC is auto-refunded from escrow — no action
              needed.
            </p>
          </div>
        )}

        {lpPaysFiat && order.status === 'FIAT_PAID' && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2.5 rounded-[13px] bg-lp-green-soft px-[13px] py-[11px]">
              <CheckCircle2 size={17} strokeWidth={1.8} className="flex-none text-lp-green" aria-hidden="true" />
              <p className="text-xs text-lp-ink">The provider marked your payout as paid.</p>
            </div>
            <div className="rounded-lg bg-lp-danger-soft p-3 text-sm text-lp-danger">
              {'Only confirm AFTER the IDR has actually arrived in your bank. Releasing without receiving payment cannot be undone.'}
            </div>
            <p className="text-[13px] text-lp-ink">
              {`Release only after ${formatIDR(fiatAmount)} has actually arrived in your bank.`}
            </p>
            {releaseTx.error && (
              <p className="text-center text-sm text-lp-danger" role="alert">
                {releaseTx.error.message}
              </p>
            )}
            {}
            <div data-testid="confirm-release">
              <HoldToRelease
                label={releaseTx.isPending ? 'Releasing…' : 'Hold to release USDC'}
                onComplete={() => releaseTx.submit(order.id).then(invalidate).catch(() => {})}
                disabled={releaseTx.isPending || releaseTx.isSuccess}
              />
            </div>
            <button
              type="button"
              className="w-full py-1 text-center text-[13px] font-semibold text-lp-danger underline"
              data-testid="open-dispute"
              onClick={() => setDisputeOpen(true)}
            >
              Didn&apos;t receive it? Open dispute
            </button>
          </div>
        )}

        {}
        {order.status === 'DISPUTED' && (
          <div className="flex items-start gap-3 rounded-lp-card border border-lp-danger/30 bg-lp-danger-soft p-4">
            <ShieldAlert size={20} strokeWidth={1.7} className="mt-0.5 flex-none text-lp-danger" aria-hidden="true" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-lp-danger">Dispute open — under review</p>
              <p className="mt-1 text-xs leading-[1.45] text-lp-ink-soft">
                An operator reviews the case and releases or refunds the escrow. Case {caseId(order.id)}.
              </p>
            </div>
          </div>
        )}

        {}
        {order.status === 'REFUNDED' && (
          <div
            className="flex flex-col items-center gap-2.5 rounded-lp-card bg-lp-amber-soft p-[22px] text-center"
            data-testid="terminal-panel"
          >
            <Undo2 size={38} strokeWidth={1.7} className="text-lp-amber" aria-hidden="true" />
            <p className="font-geist text-[19px] font-bold text-lp-ink">Refunded — escrow returned</p>
            <p className="text-[13px] text-lp-ink-soft">
              The escrow was returned on-chain — no funds were lost.
            </p>
            {canPostSettleDispute && (
              <div className="mt-1 flex flex-col items-center gap-1">
                <button
                  type="button"
                  data-testid="open-dispute"
                  onClick={() => setDisputeOpen(true)}
                  className="text-[13px] font-semibold text-lp-danger underline"
                >
                  Something wrong? Open a dispute
                </button>
                <Countdown deadline={postSettleDeadlineMs!} className="text-[11px]" />
              </div>
            )}
            <button
              type="button"
              onClick={goToOrders}
              className="mt-1 rounded-xl border border-lp-amber px-[22px] py-[11px] font-geist text-[13px] font-semibold text-lp-amber"
            >
              Done
            </button>
          </div>
        )}

        {}
        {order.status === 'RELEASED' && (
          <div
            className="flex flex-col items-center gap-2.5 rounded-lp-card bg-lp-green-soft p-[22px] text-center"
            data-testid="terminal-panel"
          >
            <CheckCircle2 size={38} strokeWidth={1.7} className="text-lp-green" aria-hidden="true" />
            <p className="font-geist text-[19px] font-bold text-lp-ink">{releasedTitle(order.flow)}</p>
            <p className="text-[13px] text-lp-ink-soft">Settled on-chain — this order is complete.</p>
            {canPostSettleDispute && (
              <div className="mt-1 flex flex-col items-center gap-1">
                <button
                  type="button"
                  data-testid="open-dispute"
                  onClick={() => setDisputeOpen(true)}
                  className="text-[13px] font-semibold text-lp-danger underline"
                >
                  Something wrong? Open a dispute
                </button>
                <Countdown deadline={postSettleDeadlineMs!} className="text-[11px]" />
              </div>
            )}
            <button
              type="button"
              onClick={goToOrders}
              className="mt-1 rounded-xl border border-lp-green px-[22px] py-[11px] font-geist text-[13px] font-semibold text-lp-green"
            >
              Done
            </button>
          </div>
        )}

        {}
        {(order.status === 'EXPIRED' || order.status === 'CANCELLED') && (
          <div
            className="flex flex-col items-center gap-2 rounded-lp-card border border-lp-line bg-lp-raise p-[22px] text-center"
            data-testid="terminal-panel"
          >
            {order.status === 'EXPIRED' ? (
              <Clock size={34} strokeWidth={1.7} className="text-lp-muted" aria-hidden="true" />
            ) : (
              <Ban size={34} strokeWidth={1.7} className="text-lp-muted" aria-hidden="true" />
            )}
            <p className="font-geist text-[16px] font-bold text-lp-ink">
              {order.status === 'EXPIRED' ? 'Order expired' : 'Order cancelled'}
            </p>
            <p className="text-[13px] text-lp-ink-soft">
              {order.status === 'EXPIRED'
                ? 'This order expired before it was completed. No funds were moved.'
                : 'This order was cancelled. No funds were moved.'}
            </p>
          </div>
        )}
      </main>

      <DisputeForm
        orderId={order.id}
        flow={order.flow}
        open={disputeOpen}
        onClose={() => setDisputeOpen(false)}
        onSubmitted={() => {
          setDisputeOpen(false)
          invalidate()
        }}
        submitFn={submitFn}
      />
    </div>
  )
}
