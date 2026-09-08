'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { useQueryClient } from '@tanstack/react-query'
import { Lock, ShieldCheck } from 'lucide-react'
import type { Quote } from '@lolipay/api-client'
import { formatIDR, formatUSDC, parseIDRInput, idrInputAccepted, IDR_INPUT_REFUSAL } from '@/lib/money'
import { QuoteBreakdown } from '@/components/QuoteBreakdown'
import { ReviewSheet, formatMMSS } from '@/components/ReviewSheet'
import { TrustlineNotice } from '@/components/TrustlineNotice'
import { useToast } from '@/components/Toast'
import { keepIdentity } from '@/lib/order-refusal'
import { useQuote } from '@/hooks/useQuote'
import { useCreateOrder } from '@/hooks/useCreateOrder'
import { DailyLimitRow } from '@/components/DailyLimitRow'

const QUICK_AMOUNTS = [250_000, 500_000, 1_000_000]
const TABS = ['Buy', 'Sell'] as const

function computeBreakdown(quote: Quote | undefined, usdcAmount: string) {
  const gross = quote && BigInt(usdcAmount) >= 1n ? BigInt(usdcAmount) : 0n
  const fees =
    gross > 0n ? (gross * BigInt(quote!.platform_fee_bps + quote!.lp_fee_bps)) / 10000n : 0n
  const net = gross - fees
  const rateText =
    quote && gross > 0n
      ? '1 USDC = ' + formatIDR(Math.round(parseInt(quote.fiat_amount) / (Number(gross) / 1e7)))
      : ''
  return { gross, fees, net, rateText }
}

interface ReviewedQuote {
  quote: Quote
  usdcAmount: string
}

export function BuyForm() {
  const router = useRouter()
  const qc = useQueryClient()
  const toast = useToast()
  const [rawIDR, setRawIDR] = React.useState('')
  const [reviewOpen, setReviewOpen] = React.useState(false)

  const [reviewed, setReviewed] = React.useState<ReviewedQuote | undefined>(undefined)

  const idrAmount = parseIDRInput(rawIDR)
  const refused = rawIDR.trim() !== '' && !idrInputAccepted(rawIDR)
  const { quote, usdcAmount, secondsLeft, expired, refusal: quoteRefusal } = useQuote(idrAmount)
  const closeReview = React.useCallback(() => {
    setReviewOpen(false)
    setReviewed(undefined)
  }, [])

  const [orderRefusal, setOrderRefusal] = React.useState<string | null>(null)
  const { submit, isPending } = useCreateOrder((message) => {
    closeReview()
    setOrderRefusal(message)
  })

  const { gross, net, rateText } = computeBreakdown(quote, usdcAmount)

  const canContinue = !!quote && !quoteRefusal && !expired && !isPending

  const [reviewedSecondsLeft, setReviewedSecondsLeft] = React.useState(0)
  React.useEffect(() => {
    if (!reviewed) {
      setReviewedSecondsLeft(0)
      return
    }
    const update = () =>
      setReviewedSecondsLeft(
        Math.max(0, Math.floor((Date.parse(reviewed.quote.expires_at) - Date.now()) / 1000)),
      )
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [reviewed])
  const reviewedExpired = !!reviewed && reviewedSecondsLeft <= 0

  React.useEffect(() => {
    if (reviewOpen && reviewedExpired) {
      closeReview()
      toast('Your price expired — getting a fresh quote…', 'info')
      qc.invalidateQueries({ queryKey: ['quote', usdcAmount] })
    }
  }, [reviewOpen, reviewedExpired, qc, usdcAmount, toast, closeReview])

  const { net: reviewedNet, rateText: reviewedRateText } = computeBreakdown(
    reviewed?.quote,
    reviewed?.usdcAmount ?? '0',
  )

  return (
    <div className="flex flex-col gap-3.5">
      {}
      <div className="flex rounded-[14px] bg-lp-line-2 p-1 text-[13px] font-semibold">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => {
              if (tab === 'Sell') router.push('/sell')
            }}
            className={
              'flex-1 rounded-[10px] py-2.5 transition ' +
              (tab === 'Buy'
                ? 'bg-lp-surface text-lp-accent-ink shadow-[0_1px_3px_rgba(25,21,16,.1)]'
                : 'text-lp-muted')
            }
          >
            {tab}
          </button>
        ))}
      </div>

      {}
      <TrustlineNotice />

      <div className="flex flex-col gap-4 rounded-lp-card border border-lp-line bg-lp-surface p-[18px]">
        {}
        <div>
          <label
            htmlFor="buy-idr-input"
            className="mb-2 block text-[11px] font-semibold uppercase tracking-[.06em] text-lp-muted"
          >
            You pay
          </label>
          <div className="flex items-center gap-2 border-b-2 border-lp-line pb-2">
            <span className="font-geist text-[26px] font-bold text-lp-muted">Rp</span>
            <input
              id="buy-idr-input"
              type="text"
              inputMode="numeric"
              className="w-full flex-1 bg-transparent font-geist text-[32px] font-bold tracking-[-0.02em] text-lp-ink tabular-nums outline-none"
              placeholder="0"
              value={rawIDR}
              onChange={(e) => {
                setRawIDR(e.target.value)
                setOrderRefusal(keepIdentity)
              }}
              aria-invalid={refused}
              aria-describedby={refused ? 'buy-idr-refusal' : undefined}
            />
          </div>
          {refused && (
            <p id="buy-idr-refusal" className="mt-1.5 text-xs text-lp-danger" role="alert">
              {IDR_INPUT_REFUSAL}
            </p>
          )}
          {}
          {quote && (
            <p className="mt-1.5 text-xs text-lp-muted">
              ≈ {formatIDR(parseInt(quote.fiat_amount))} (confirmed price)
            </p>
          )}

          {}
          <div className="mt-3 flex gap-2">
            {QUICK_AMOUNTS.map((amount) => (
              <button
                key={amount}
                type="button"
                onClick={() => {
                  setRawIDR(String(amount))
                  setOrderRefusal(keepIdentity)
                }}
                className="flex-1 rounded-[10px] border border-lp-line bg-lp-raise py-2 text-xs font-semibold text-lp-ink transition hover:bg-lp-line-2"
              >
                {formatIDR(amount)}
              </button>
            ))}
          </div>
        </div>

        <div className="h-px bg-lp-line-2" />

        {}
        {quote && gross > 0n ? (
          <QuoteBreakdown
            rows={[
              { label: 'Rate (locked)', value: rateText },
              { label: 'You receive', value: `${formatUSDC(net)} USDC`, strong: true },
            ]}
          />
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-sm text-lp-muted">You receive</span>
            <span className="text-lg font-bold text-lp-ink">0.00 USDC</span>
          </div>
        )}

        {}
        {quote && !expired && (
          <div className="inline-flex items-center gap-1.5 self-start rounded-[9px] bg-lp-amber-soft px-2.5 py-[5px] text-[11.5px] font-semibold text-lp-ink">
            <Lock size={13} strokeWidth={2} className="text-lp-amber" aria-hidden="true" />
            Price held · <span className="font-geist-mono">{formatMMSS(secondsLeft)}</span>
          </div>
        )}
      </div>

      {}
      <div className="flex items-start gap-2.5 rounded-[16px] border border-lp-line-2 bg-lp-raise px-[15px] py-[13px]">
        <ShieldCheck size={18} strokeWidth={1.6} className="mt-0.5 flex-none text-lp-ink" aria-hidden="true" />
        <span className="text-xs leading-[1.4] text-lp-ink-soft">
          Your USDC lands straight in <b>your</b> Stellar wallet. lolipay never holds your funds.
        </span>
      </div>

      {(orderRefusal ?? quoteRefusal) && (
        <p role="alert" data-testid="order-refusal" className="text-center text-xs text-lp-danger">
          {orderRefusal ?? quoteRefusal}
        </p>
      )}

      <button
        type="button"
        disabled={!canContinue}
        onClick={() => {
          if (!canContinue || !quote) return

          setOrderRefusal(null)
          setReviewed({ quote, usdcAmount })
          setReviewedSecondsLeft(
            Math.max(0, Math.floor((Date.parse(quote.expires_at) - Date.now()) / 1000)),
          )
          setReviewOpen(true)
        }}
        className="w-full rounded-lp-cta bg-lp-ink py-4 font-geist text-[15px] font-semibold text-lp-paper transition disabled:cursor-not-allowed disabled:opacity-50"
      >
        Continue to pay
      </button>

      <p className="text-center text-xs text-lp-muted">Non-custodial · you sign with your wallet</p>
      <DailyLimitRow />

      <ReviewSheet
        open={reviewOpen}
        onClose={closeReview}
        onConfirm={() => reviewed && submit(reviewed.quote.quote_id)}
        confirming={isPending}
        rows={{
          youPay: reviewed ? formatIDR(parseInt(reviewed.quote.fiat_amount)) : '',
          youReceive: `${formatUSDC(reviewedNet)} USDC`,
          rate: reviewedRateText,
          rateHeldSecondsLeft: reviewedSecondsLeft,
        }}
      />
    </div>
  )
}
