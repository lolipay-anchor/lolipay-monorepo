'use client'

import * as React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { CreditCard } from 'lucide-react'
import { createQuote, createOrder } from '@lolipay/api-client'
import type { Quote } from '@lolipay/api-client'
import { useAuth } from '@/app/providers'
import { client } from '@/lib/client'
import { formatIDR, formatUSDC, usdcToBaseUnits } from '@/lib/money'
import { formatUsdcBalance } from '@/lib/balance'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { QuoteBreakdown } from '@/components/QuoteBreakdown'
import { ReviewSheet } from '@/components/ReviewSheet'
import { explainOrderRefusal } from '@/lib/order-refusal'
import { useToast } from '@/components/Toast'
import { DailyLimitRow } from '@/components/DailyLimitRow'

const CONFIG = {
  flow: 'WITHDRAW' as const,
  rail: 'BANK' as const,
  sellLabel: 'You sell',
  usdcPlaceholder: '0.00',
  receiveLabel: 'You receive',
  payLabel: 'Your bank account (merchant pays here)',
  payPlaceholder: 'e.g. BCA 1234567890 a/n Your Name',
  missingPayError: 'Enter your bank account details',
  ctaLabel: 'Lock USDC & sell',
  footnote: 'You sign the lock with your wallet · an LP pays your bank',
}

interface ReviewedQuote {
  quote: Quote
  usdcBaseUnits: string
}

const BALANCE_RE = /^\d+(\.\d+)?$/

function balanceToBaseUnits(balance: string): bigint | null {
  if (!BALANCE_RE.test(balance)) return null
  const [wholeRaw, fracRaw = ''] = balance.split('.')
  const whole = wholeRaw || '0'
  const frac = (fracRaw + '0000000').slice(0, 7)
  return BigInt(whole) * 10_000_000n + BigInt(frac || '0')
}

export function SellForm() {
  const cfg = CONFIG
  const router = useRouter()
  const qc = useQueryClient()
  const toast = useToast()
  const auth = useAuth()
  const [usdcInput, setUsdcInput] = React.useState('')
  const [payDetails, setPayDetails] = React.useState('')
  const [inputError, setInputError] = React.useState<string | null>(null)
  const [reviewOpen, setReviewOpen] = React.useState(false)

  const [reviewed, setReviewed] = React.useState<ReviewedQuote | undefined>(undefined)

  let usdcBaseUnits = '0'
  let usdcValid = false
  try {
    if (usdcInput.trim()) {
      usdcBaseUnits = usdcToBaseUnits(usdcInput)
      usdcValid = true
    }
  } catch {
    usdcValid = false
  }

  const quoteQueryKey = ['sellQuote', cfg.flow, usdcBaseUnits]
  const { data: quote, isLoading: quoteLoading } = useQuery({
    queryKey: quoteQueryKey,
    queryFn: () =>
      createQuote(client, { flow: cfg.flow, rail: cfg.rail, usdcAmount: usdcBaseUnits }),
    enabled: usdcValid && BigInt(usdcBaseUnits) >= 1n,
    staleTime: 10_000,
  })

  const [secondsLeft, setSecondsLeft] = React.useState(0)
  React.useEffect(() => {
    if (!quote) {
      setSecondsLeft(0)
      return
    }
    const update = () =>
      setSecondsLeft(Math.max(0, Math.floor((Date.parse(quote.expires_at) - Date.now()) / 1000)))
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [quote])
  const expired = !!quote && secondsLeft <= 0

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

  const { balance } = useUsdcBalance(auth.address)
  const balanceBaseUnits = balance != null ? balanceToBaseUnits(balance) : null

  const balanceUnknown = balance != null && balanceBaseUnits === null
  const exceedsBalance =
    usdcValid && balanceBaseUnits != null && BigInt(usdcBaseUnits) > balanceBaseUnits

  const closeReview = React.useCallback(() => {
    setReviewOpen(false)
    setReviewed(undefined)
  }, [])

  const {
    mutate: submit,
    isPending,
  } = useMutation({
    mutationFn: (quoteId: string) =>
      createOrder(client, { quoteId, userPaymentMethod: payDetails.trim() }),
    onSuccess: (res) => router.push('/orders/' + res.order.id),
    onError: (e) => {
      closeReview()
      toast(explainOrderRefusal((e as Error).message), 'error')
    },
  })

  const canContinue = !!quote && !expired && !isPending

  const handleContinue = () => {
    if (!usdcValid) {
      setInputError('Enter a valid USDC amount')
      return
    }
    if (exceedsBalance) {
      setInputError('Amount exceeds your balance')
      return
    }
    if (!payDetails.trim()) {
      setInputError(cfg.missingPayError)
      return
    }
    if (!quote || expired) {
      setInputError('Getting the latest price — try again in a moment')
      return
    }
    setInputError(null)

    setReviewed({ quote, usdcBaseUnits })
    setReviewedSecondsLeft(
      Math.max(0, Math.floor((Date.parse(quote.expires_at) - Date.now()) / 1000)),
    )
    setReviewOpen(true)
  }


  React.useEffect(() => {
    if (reviewOpen && reviewedExpired) {
      closeReview()
      toast('Your price expired — getting a fresh quote…', 'info')
      qc.invalidateQueries({ queryKey: ['sellQuote', cfg.flow, usdcBaseUnits] })
    }
  }, [reviewOpen, reviewedExpired, qc, toast, cfg.flow, usdcBaseUnits, closeReview])

  return (
    <div className="flex flex-col gap-3.5">
      {}
      <div className="flex rounded-[14px] bg-lp-line-2 p-1 text-[13px] font-semibold">
        {(['Buy', 'Sell'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => {
              if (tab === 'Buy') router.push('/buy')
            }}
            className={
              'flex-1 rounded-[10px] py-2.5 transition ' +
              (tab === 'Sell'
                ? 'bg-lp-surface text-lp-accent-ink shadow-[0_1px_3px_rgba(25,21,16,.1)]'
                : 'text-lp-muted')
            }
          >
            {tab}
          </button>
        ))}
      </div>

      <div className="flex flex-col gap-4 rounded-lp-card border border-lp-line bg-lp-surface p-[18px]">
        {}
        <div>
          <label
            htmlFor="sell-usdc-input"
            className="mb-2 block text-[11px] font-semibold uppercase tracking-[.06em] text-lp-muted"
          >
            {cfg.sellLabel}
          </label>
          <div className="flex items-center gap-2 border-b-2 border-lp-line pb-2">
            <input
              id="sell-usdc-input"
              type="text"
              inputMode="decimal"
              className="w-full flex-1 bg-transparent font-geist text-[32px] font-bold tracking-[-0.02em] text-lp-ink tabular-nums outline-none"
              placeholder={cfg.usdcPlaceholder}
              value={usdcInput}
              onChange={(e) => setUsdcInput(e.target.value)}
            />
            <span className="font-geist text-[20px] font-bold text-lp-muted">USDC</span>
          </div>
          <p className="mt-2 text-xs text-lp-muted">
            Balance{' '}
            <span className="font-geist-mono text-lp-ink">
              {balance === undefined || balanceUnknown ? '—' : formatUsdcBalance(balance ?? '0')} USDC
            </span>
            {exceedsBalance && (
              <span className="font-semibold text-lp-danger"> · exceeds balance</span>
            )}
          </p>
        </div>

        <div className="h-px bg-lp-line-2" />

        {}
        {quote ? (
          <QuoteBreakdown
            rows={[
              { label: 'Rate (locked)', value: `1 USDC = ${formatIDR(Math.round(Number(quote.rate)))}` },
              {
                label: cfg.receiveLabel,
                value: formatIDR(parseInt(quote.fiat_amount, 10)),
                strong: true,
              },
            ]}
          />
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-sm text-lp-muted">{cfg.receiveLabel}</span>
            <span className="text-lg font-bold text-lp-ink">Rp 0</span>
          </div>
        )}
        {quoteLoading && <p className="text-xs text-lp-muted">Getting best price…</p>}

        {}
        <div className="rounded-[13px] border border-lp-line-2 bg-lp-raise p-3 px-3.5">
          <div className="mb-2 flex items-center gap-2.5">
            <CreditCard size={20} strokeWidth={1.7} className="flex-none text-lp-ink" aria-hidden="true" />
            <label htmlFor="sell-pay-input" className="text-[13px] font-semibold text-lp-ink">
              {cfg.payLabel}
            </label>
          </div>
          <input
            id="sell-pay-input"
            type="text"
            className="w-full rounded-[10px] border border-lp-line bg-lp-surface px-3 py-2.5 text-sm text-lp-ink outline-none"
            placeholder={cfg.payPlaceholder}
            value={payDetails}
            onChange={(e) => setPayDetails(e.target.value)}
            maxLength={500}
          />
        </div>
      </div>

      {inputError && <p className="text-center text-xs text-lp-danger">{inputError}</p>}

      <button
        type="button"
        disabled={!canContinue}
        onClick={handleContinue}
        className="w-full rounded-lp-cta bg-lp-ink py-4 font-geist text-[15px] font-semibold text-lp-paper transition disabled:cursor-not-allowed disabled:opacity-50"
      >
        {cfg.ctaLabel}
      </button>

      <p className="text-center text-xs text-lp-muted">{cfg.footnote}</p>
      <DailyLimitRow />

      <ReviewSheet
        open={reviewOpen}
        onClose={closeReview}
        onConfirm={() => reviewed && submit(reviewed.quote.quote_id)}
        confirming={isPending}
        rows={{
          youPay: `${formatUSDC(BigInt(reviewed?.usdcBaseUnits ?? '0'))} USDC`,
          youReceive: reviewed ? formatIDR(parseInt(reviewed.quote.fiat_amount, 10)) : '',
          rate: reviewed ? `1 USDC = ${formatIDR(Math.round(Number(reviewed.quote.rate)))}` : '',
          rateHeldSecondsLeft: reviewedSecondsLeft,
        }}
      />
    </div>
  )
}
