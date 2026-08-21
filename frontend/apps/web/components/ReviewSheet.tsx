'use client'

import * as React from 'react'
import { ShieldCheck } from 'lucide-react'
import { BottomSheet } from '@lolipay/ui'

export interface ReviewSheetRows {
  youPay: string
  youReceive: string
  rate: string

  rateHeldSecondsLeft?: number

  fee?: string
}

export interface ReviewSheetProps {
  open: boolean
  onClose: () => void
  onConfirm: () => void

  confirming: boolean
  rows: ReviewSheetRows
  confirmLabel?: string

  youReceiveLabel?: string
}

export function formatMMSS(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(s / 60)
  const sec = String(s % 60).padStart(2, '0')
  return `${m}:${sec}`
}

function Row({
  label,
  value,
  strong,
  dashedTop,
}: {
  label: string
  value: string
  strong?: boolean
  dashedTop?: boolean
}) {
  return (
    <div
      className={
        'flex items-center justify-between text-[13px] ' +
        (dashedTop ? 'border-t border-dashed border-lp-line pt-[9px]' : '')
      }
    >
      <span className="text-lp-muted">{label}</span>
      <span
        className={
          'font-geist-mono tabular-nums ' +
          (strong ? 'font-semibold text-lp-accent-ink' : 'font-medium text-lp-ink')
        }
      >
        {value}
      </span>
    </div>
  )
}

export function ReviewSheet({
  open,
  onClose,
  onConfirm,
  confirming,
  rows,
  confirmLabel = 'Confirm — sign',
  youReceiveLabel = 'You receive',
}: ReviewSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} ariaLabel="Review order" dismissible={!confirming}>
      <div className="flex flex-col gap-[13px]">
        <div className="text-center font-geist text-[19px] font-bold text-lp-ink">Review order</div>

        <div className="flex flex-col gap-2.5 rounded-lp-card bg-lp-raise p-4">
          <Row label="You pay" value={rows.youPay} />
          <Row label={youReceiveLabel} value={rows.youReceive} strong />
          <Row
            label={
              rows.rateHeldSecondsLeft != null
                ? `Rate · held ${formatMMSS(rows.rateHeldSecondsLeft)}`
                : 'Rate'
            }
            value={rows.rate}
          />
        </div>

        <div className="flex items-start gap-2.5 rounded-[12px] bg-lp-green-soft px-[13px] py-[11px]">
          <ShieldCheck size={16} strokeWidth={1.8} className="mt-0.5 flex-none text-lp-green" aria-hidden="true" />
          <p className="text-xs leading-[1.4] text-lp-ink-soft">
            Funds are held in on-chain escrow and released only when both sides confirm. If
            anything goes wrong, you&apos;re refunded.
          </p>
        </div>

        <button
          type="button"
          disabled={confirming}
          onClick={onConfirm}
          className="w-full rounded-lp-cta bg-lp-accent py-4 font-geist text-[15px] font-semibold text-white shadow-lp-cta transition disabled:cursor-not-allowed disabled:opacity-60"
        >
          {confirming ? (
            <span aria-label="loading" className="inline-block animate-spin">
              ◌
            </span>
          ) : (
            confirmLabel
          )}
        </button>

        <button
          type="button"
          onClick={onClose}
          className="text-center font-geist text-[13px] font-semibold text-lp-muted"
        >
          Back
        </button>
      </div>
    </BottomSheet>
  )
}
