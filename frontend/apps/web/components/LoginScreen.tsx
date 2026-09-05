'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { getRate, getMarkets } from '@lolipay/api-client'
import type { Market } from '@lolipay/api-client'
import { useWallet } from '@lolipay/wallet'
import { DarkHeroCard } from '@lolipay/ui'
import { ShieldCheck, Zap } from 'lucide-react'
import { useAuth } from '@/app/providers'
import { client } from '@/lib/client'
import { formatIDR } from '@/lib/money'

const FALLBACK_COUNTRIES: Market[] = [
  { code: 'IDR', country: 'Indonesia', currency_symbol: 'Rp', locale: 'id-ID', rail_name: 'QRIS', enabled: true },
  { code: 'PHP', country: 'Philippines', currency_symbol: '₱', locale: 'en-PH', rail_name: 'InstaPay', enabled: false },
  { code: 'VND', country: 'Vietnam', currency_symbol: '₫', locale: 'vi-VN', rail_name: 'VietQR', enabled: false },
  { code: 'INR', country: 'India', currency_symbol: '₹', locale: 'en-IN', rail_name: 'UPI', enabled: false },
  { code: 'THB', country: 'Thailand', currency_symbol: '฿', locale: 'th-TH', rail_name: 'PromptPay', enabled: false },
  { code: 'BRL', country: 'Brazil', currency_symbol: 'R$', locale: 'pt-BR', rail_name: 'PIX', enabled: false },
]

const FEATURES: Array<{
  Icon: typeof ShieldCheck
  iconBg: string
  iconColor: string
  label: string
}> = [
  {
    Icon: ShieldCheck,
    iconBg: 'bg-lp-green-soft',
    iconColor: 'text-lp-green',
    label: 'Non-custodial — you hold the keys',
  },
  {
    Icon: Zap,
    iconBg: 'bg-lp-line-2',
    iconColor: 'text-lp-ink',
    label: 'Settled in about two minutes',
  },
]

export function LoginScreen() {
  const wallet = useWallet()
  const auth = useAuth()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [country, setCountry] = React.useState('IDR')

  const { data: rate } = useQuery({
    queryKey: ['rate'],
    queryFn: () => getRate(client),
    refetchInterval: 12000,
  })

  const { data: markets, isLoading: marketsLoading, isError: marketsError } = useQuery({
    queryKey: ['markets'],
    queryFn: () => getMarkets(client),
  })
  const countries = markets && !marketsLoading && !marketsError ? markets : FALLBACK_COUNTRIES

  const handleConnect = async () => {
    setBusy(true)
    setError(null)
    try {
      const addr = wallet.address || (await wallet.connect())
      await auth.login(addr)
    } catch (e) {
      console.error('[login] connect failed:', e)
      setError(e instanceof Error ? e.message : 'Connection failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-lp-paper px-6 py-[26px] animate-lp-rise">
      <div className="flex flex-1 flex-col justify-center gap-6">
        {}
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-[20px] bg-lp-accent shadow-lp-brand">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="9" r="6.4" fill="#fff" />
              <rect x="10.6" y="13.5" width="2.8" height="8.2" rx="1.4" fill="#fff" />
            </svg>
          </span>
          <div>
            <h1 className="font-geist text-[30px] font-bold tracking-[-0.03em] text-lp-ink">
              lolipay
            </h1>
            <p className="mx-auto mt-2 max-w-[270px] text-[15px] leading-relaxed text-lp-ink-soft">
              Buy &amp; sell USDC for rupiah, peer-to-peer — non-custodial.
            </p>
          </div>
        </div>

        {}
        <DarkHeroCard>
          <div className="flex items-center justify-between">
            <span className="font-geist-mono text-[10.5px] uppercase tracking-[.14em] opacity-60">
              USDC / IDR
            </span>
            <span className="flex items-center gap-[5px] text-[10.5px] font-semibold opacity-85">
              <span className="h-1.5 w-1.5 animate-lp-pulse rounded-full bg-lp-accent" />
              LIVE
            </span>
          </div>
          <div className="mt-2 font-geist-mono text-[32px] font-bold tracking-[-0.03em] tabular-nums">
            {rate ? formatIDR(Math.round(parseFloat(rate.rate))) : '—'}
          </div>
        </DarkHeroCard>

        {}
        <div className="flex flex-col gap-2.5">
          {FEATURES.map(({ Icon, iconBg, iconColor, label }) => (
            <div
              key={label}
              className="flex items-center gap-3 rounded-2xl border border-lp-line bg-lp-surface px-[15px] py-[13px]"
            >
              <span
                className={`flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] ${iconBg}`}
              >
                <Icon size={17} strokeWidth={1.9} className={iconColor} aria-hidden="true" />
              </span>
              <span className="text-[13px] font-medium text-lp-ink">{label}</span>
            </div>
          ))}
        </div>
      </div>

      {}
      <div className="mt-[22px] flex flex-col gap-3">
        <div>
          <div className="mb-[9px] text-center text-[11px] font-semibold uppercase tracking-[.05em] text-lp-muted">
            Choose your country
          </div>
          <div className="flex gap-2 overflow-x-auto pb-0.5">
            {countries.map((c) => {
              const active = c.enabled && country === c.code
              return (
                <button
                  key={c.code}
                  type="button"
                  disabled={!c.enabled}
                  aria-pressed={active}
                  onClick={() => c.enabled && setCountry(c.code)}
                  className={[
                    'flex flex-none flex-col items-center gap-0.5 rounded-2xl border px-4 py-2.5 text-center transition',
                    active
                      ? 'border-lp-accent bg-lp-accent-soft text-lp-accent-ink'
                      : c.enabled
                        ? 'border-lp-line bg-lp-surface text-lp-ink'
                        : 'border-lp-line bg-lp-surface text-lp-faint opacity-60',
                  ].join(' ')}
                >
                  <span className="font-geist-mono text-[13px] font-bold">{c.code}</span>
                  <span className="text-[11px] opacity-80">{c.country}</span>
                  {!c.enabled && (
                    <span className="text-[9.5px] font-medium text-lp-faint">Coming soon</span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        <button
          type="button"
          onClick={handleConnect}
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lp-cta bg-lp-ink py-4 font-geist text-[15px] font-semibold text-lp-paper transition disabled:opacity-70"
        >
          {busy ? (
            <span aria-label="loading" className="inline-block animate-spin">
              ◌
            </span>
          ) : (
            <>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <rect x="3" y="6" width="18" height="13" rx="3" stroke="currentColor" strokeWidth="1.9" />
                <path d="M16 12h2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
                <path d="M3 10h18" stroke="currentColor" strokeWidth="1.9" />
              </svg>
              Connect wallet
            </>
          )}
        </button>

        {}
        {busy && !error && (
          <p className="text-center text-xs text-lp-muted" role="status">
            Approve the request in your wallet. On a phone, open your wallet app (e.g. Freighter)
            to confirm.
          </p>
        )}

        {error && (
          <p className="text-center text-xs text-lp-danger" role="alert">
            {error}
          </p>
        )}

        <p className="mt-1.5 text-center text-[11.5px] leading-relaxed text-lp-muted">
          Settles via bank transfer in Indonesia · your keys never leave your device.
        </p>
      </div>
    </div>
  )
}
