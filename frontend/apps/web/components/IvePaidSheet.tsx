'use client'

import * as React from 'react'
import { BottomSheet } from '@lolipay/ui'
import type { Order } from '@lolipay/api-client'
import { formatIDR } from '@/lib/money'
import { useMarkPaid, type SubmitFn } from '@/hooks/useMarkPaid'

interface Props {
  order: Pick<Order, 'id' | 'fiat_amount' | 'payment_instructions'>
  open: boolean
  onClose: () => void
  onConfirmed: () => void

  submitFn?: SubmitFn
}

export function IvePaidSheet({ order, open, onClose, onConfirmed, submitFn }: Props) {
  const [checked, setChecked] = React.useState(false)
  const { submit, isPending, error, reset } = useMarkPaid(submitFn)

  React.useEffect(() => {
    if (open) {
      setChecked(false)
      reset()
    }
  }, [open, reset])

  const fiatAmount = formatIDR(parseInt(order.fiat_amount, 10))

  async function handleConfirm() {
    try {
      await submit(order.id)
      onConfirmed()
    } catch {
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} ariaLabel="Did you already pay?" dismissible={!isPending}>
      <h2 className="mb-4 font-geist text-lg font-bold text-lp-ink">Did you already pay?</h2>

      {}
      <div className="mb-4 rounded-lg bg-lp-danger-soft p-3 text-sm text-lp-danger">
        <p className="mb-1 font-semibold">Warning</p>
        <p>
          Only confirm AFTER your transfer is actually completed. Confirming
          without paying can freeze your reputation and start a dispute.
        </p>
      </div>

      {}
      <div className="mb-4 space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="text-lp-muted">Amount</span>
          <span className="font-geist-mono font-semibold text-lp-ink">{fiatAmount}</span>
        </div>
        {order.payment_instructions && (
          <div className="flex items-start justify-between gap-2 text-sm">
            <span className="shrink-0 text-lp-muted">To</span>
            <span className="break-all text-right font-semibold text-lp-ink">
              {order.payment_instructions}
            </span>
          </div>
        )}
      </div>

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
          I confirm I transferred exactly {fiatAmount} to the account above.
        </span>
      </label>

      {}
      {error && (
        <p className="mb-3 text-sm text-lp-danger" role="alert">
          {error.message}
        </p>
      )}

      {}
      <div className="space-y-2">
        <button
          type="button"
          disabled={!checked || isPending}
          onClick={handleConfirm}
          className="w-full rounded-lp-cta bg-lp-ink py-3.5 font-geist text-[15px] font-semibold text-lp-paper transition disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isPending ? (
            <span aria-label="loading" className="inline-block animate-spin">
              ◌
            </span>
          ) : (
            "Yes, I've paid — sign"
          )}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={isPending}
          className="w-full py-3 text-center font-geist text-sm font-semibold text-lp-muted disabled:cursor-not-allowed disabled:opacity-50"
        >
          Not yet — go back
        </button>
      </div>
    </BottomSheet>
  )
}
