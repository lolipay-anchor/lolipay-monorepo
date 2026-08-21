'use client'
import * as React from 'react'
import { MARKETS, formatLocal, type Market } from '../lib/markets'
import { estimateBuy, estimateSell } from '../lib/estimate'
import { useLiveRate } from '../hooks/useLiveRate'

const sanitize = (raw: string) => raw.replace(/[^0-9.]/g, '')
const numOnly = (n: number, m: Market) => formatLocal(n, m).replace(`${m.symbol} `, '')

const tabActive = 'flex-1 rounded-[9px] bg-lp-surface px-[18px] py-2.5 text-lp-accent-ink shadow'
const tabIdle = 'flex-1 rounded-[9px] bg-transparent px-[18px] py-2.5 text-lp-muted'

type Tab = 'buy' | 'sell'

export function BuySellWidget() {
  const [tab, setTab] = React.useState<Tab>('buy')
  const [payLocal, setPayLocal] = React.useState('500000')
  const [paySell, setPaySell] = React.useState('30')
  const [mkCode, setMkCode] = React.useState(MARKETS[0].code)
  const [mkOpen, setMkOpen] = React.useState(false)

  const market = MARKETS.find((m) => m.code === mkCode) ?? MARKETS[0]
  const { rate, live } = useLiveRate(mkCode)
  const isBuy = tab === 'buy'

  const local = parseFloat(sanitize(payLocal)) || 0
  const usdc = parseFloat(sanitize(paySell)) || 0

  const buy = rate != null ? estimateBuy(local, rate) : null
  const sell = rate != null ? estimateSell(usdc, rate) : null

  const getValue = isBuy ? (buy ? buy.usdcNet.toFixed(2) : '—') : sell ? numOnly(sell.localNet, market) : '—'
  const getUnit = isBuy ? 'USDC' : market.code
  const feeText = isBuy
    ? buy
      ? `${buy.feeUsdc.toFixed(2)} USDC`
      : '—'
    : sell
      ? formatLocal(sell.feeLocal, market)
      : '—'

  const buyChips =
    rate != null
      ? [15, 30, 60].map((u) => {
          const v = Math.round(u * rate)
          return { label: numOnly(v, market), pick: () => setPayLocal(String(v)), disabled: false }
        })
      : [15, 30, 60].map(() => ({ label: '—', pick: () => {}, disabled: true }))
  const sellChips = [25, 50, 100].map((u) => ({ label: `${u} USDC`, pick: () => setPaySell(String(u)), disabled: false }))
  const chips = isBuy ? buyChips : sellChips

  const pickMarket = (m: Market) => {
    if (!m.enabled) return
    setMkCode(m.code)
    setMkOpen(false)

    setPayLocal(String(Math.round(30 * (rate ?? m.base))))
  }

  const onPay = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = sanitize(e.target.value)
    if (isBuy) setPayLocal(v)
    else setPaySell(v)
  }

  return (
    <div className="animate-lp-rise" style={{ animationDelay: '0.1s' }}>
      <div className="rounded-lp-card-lg border border-lp-line bg-lp-surface p-[22px] shadow-[0_30px_60px_-30px_rgba(25,21,16,.35),0_2px_6px_rgba(25,21,16,.04)]">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex rounded-xl bg-lp-line-2 p-1 text-sm font-semibold">
            <button type="button" onClick={() => setTab('buy')} className={isBuy ? tabActive : tabIdle}>
              Buy
            </button>
            <button type="button" onClick={() => setTab('sell')} className={tab === 'sell' ? tabActive : tabIdle}>
              Sell
            </button>
          </div>
          <span className="flex items-center gap-1.5 font-geist-mono text-[11.5px] text-lp-muted">
            {live && <span className="h-1.5 w-1.5 animate-lp-pulse rounded-full bg-lp-green" />}
            {live ? 'live rate' : 'indicative rate'}
          </span>
        </div>

        {}
        <div className="relative mb-3">
          <button
            type="button"
            onClick={() => setMkOpen((o) => !o)}
            className="flex w-full items-center justify-between rounded-lp-tile border border-lp-line bg-lp-raise px-[13px] py-[11px]"
          >
            <span className="flex items-center gap-2.5">
              <span className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-lp-ink font-geist-mono text-[11px] font-bold text-lp-paper">
                {market.code}
              </span>
              <span className="flex flex-col text-left">
                <span className="text-[13.5px] font-semibold text-lp-ink">{market.country}</span>
                <span className="text-[11px] text-lp-muted">{market.code}</span>
              </span>
            </span>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M6 9l6 6 6-6" className="stroke-lp-muted" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {mkOpen && (
            <div className="absolute inset-x-0 top-[calc(100%+6px)] z-[6] overflow-hidden rounded-2xl border border-lp-line bg-lp-surface shadow-[0_22px_44px_-18px_rgba(0,0,0,.28)]">
              {MARKETS.map((m) => (
                <button
                  key={m.code}
                  type="button"
                  disabled={!m.enabled}
                  aria-label={`${m.country} · ${m.code}`}
                  onClick={() => pickMarket(m)}
                  className={`flex w-full items-center justify-between border-b border-lp-line-2 px-[15px] py-3 text-left last:border-b-0 ${
                    m.code === market.code ? 'bg-lp-accent-soft' : 'bg-transparent'
                  } ${m.enabled ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                >
                  <span className="flex flex-col">
                    <span className="text-[13.5px] font-semibold text-lp-ink">
                      {m.country} · {m.code}
                    </span>
                    {!m.enabled && <span className="text-[11px] text-lp-muted">Coming soon</span>}
                  </span>
                  {m.code === market.code && (
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
                      <path d="M5 12l4 4 10-11" className="stroke-lp-accent-ink" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

          <>
            {}
            <div className="rounded-lp-tile border border-lp-line bg-lp-raise px-4 py-[15px]">
              <div className="mb-[7px] text-[11.5px] font-semibold uppercase tracking-[.05em] text-lp-muted">
                {isBuy ? 'You pay' : 'You sell'}
              </div>
              <div className="flex items-center gap-2.5">
                {isBuy && <span className="font-geist text-2xl font-bold text-lp-muted">{market.symbol}</span>}
                <input
                  inputMode="decimal"
                  value={isBuy ? payLocal : paySell}
                  onChange={onPay}
                  className="min-w-0 flex-1 border-none bg-transparent font-geist text-[30px] font-bold tabular-nums tracking-[-.02em] text-lp-ink outline-none"
                />
                {!isBuy && <span className="font-geist text-xl font-bold text-lp-muted">USDC</span>}
              </div>
            </div>

            <div className="relative z-[2] -my-[9px] flex justify-center">
              <span className="flex h-[34px] w-[34px] items-center justify-center rounded-[11px] border-[3px] border-lp-surface bg-lp-ink">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M8 4v12M8 16l-3-3M16 20V8M16 8l3 3"
                    className="stroke-lp-paper"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </div>

            {}
            <div className="rounded-lp-tile border border-lp-line bg-lp-raise px-4 py-[15px]">
              <div className="mb-[7px] text-[11.5px] font-semibold uppercase tracking-[.05em] text-lp-muted">You receive</div>
              <div className="flex items-baseline gap-2">
                <span className="font-geist text-[30px] font-bold tabular-nums tracking-[-.02em] text-lp-accent-ink">{getValue}</span>
                <span className="font-geist text-base font-bold text-lp-muted">{getUnit}</span>
              </div>
            </div>

            <div className="mt-3.5 flex gap-2">
              {chips.map((c, i) => (
                <button
                  key={`${c.label}-${i}`}
                  type="button"
                  disabled={c.disabled}
                  onClick={c.pick}
                  className="flex-1 rounded-[11px] border border-lp-line bg-lp-raise py-2.5 font-geist text-[12.5px] font-semibold text-lp-ink disabled:opacity-50"
                >
                  {c.label}
                </button>
              ))}
            </div>
          </>
        
        <div className="mt-3.5 flex justify-between border-t border-lp-line-2 pt-3.5 text-[12.5px] text-lp-muted">
          <span>Rate</span>
          <span className="font-geist-mono tabular-nums text-lp-ink">{rate != null ? `1 USDC = ${formatLocal(rate, market)}` : '—'}</span>
        </div>
        <div className="mt-1.5 flex justify-between text-[12.5px] text-lp-muted">
          <span>Network + LP fee</span>
          <span className="font-geist-mono tabular-nums text-lp-ink">{feeText}</span>
        </div>
        <div className="mt-1.5 flex justify-between text-[12.5px] text-lp-muted">
          <span>Settlement</span>
          <span className="font-geist-mono text-lp-ink">
            {market.rail} · {market.country}
          </span>
        </div>

        {}
        <a
          href="https://app.lolipay.app"
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-lp-cta bg-lp-accent py-[15px] font-geist text-[15px] font-semibold text-white no-underline shadow-lp-cta"
        >
          Connect wallet to continue
        </a>
        <p className="mt-[11px] text-center text-[11.5px] text-lp-muted">Non-custodial · price held for 5 min at checkout</p>
      </div>
    </div>
  )
}
