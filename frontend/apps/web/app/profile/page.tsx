'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { Copy, Settings } from 'lucide-react'
import { useWallet } from '@lolipay/wallet'
import { DarkHeroCard, Skeleton, NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { useAuth } from '@/app/providers'
import { shortAddress, tierLabel, tierBadgeClasses, nextTier, nextTierThreshold, formatUsdcAmount } from '@/lib/format'
import { AppHeader } from '@/components/AppHeader'
import { useToast } from '@/components/Toast'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { useMyProfile } from '@/hooks/useMyProfile'
import { formatUsdcBalance } from '@/lib/balance'

function TierCard() {
  const { data: profile, isLoading } = useMyProfile()

  if (isLoading) {
    return (
      <div className="rounded-lp-card border border-lp-line bg-lp-surface p-4" data-testid="tier-card-skeleton">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="mt-3 h-1.5 w-full rounded-full" />
        <Skeleton className="mt-3 h-10 w-full" />
      </div>
    )
  }

  if (!profile) return null

  const next = nextTier(profile.tier)
  const threshold = nextTierThreshold(profile.tier)
  const progressPct = threshold
    ? Math.min(100, Math.round((profile.completed_trades / threshold) * 100))
    : 100

  return (
    <div className="rounded-lp-card border border-lp-line bg-lp-surface p-4" data-testid="tier-card">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[.09em] text-lp-muted">
          Your tier
        </span>
        <span
          className={`rounded-lp-pill px-2.5 py-1 text-xs font-bold ${tierBadgeClasses(profile.tier)}`}
        >
          {tierLabel(profile.tier)}
        </span>
      </div>

      {threshold != null && next ? (
        <>
          <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-lp-line-2">
            <div
              className="h-1.5 rounded-full bg-lp-accent transition-[width]"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-lp-ink-soft">
            {}
            {Math.min(profile.completed_trades, threshold)} / {threshold} trades to {tierLabel(next)}
          </p>
        </>
      ) : (
        <p className="mt-2.5 text-[11px] font-semibold text-lp-amber">Highest tier reached</p>
      )}

      <div className="mt-3.5 grid grid-cols-3 gap-2">
        <div className="rounded-lp-tile bg-lp-raise p-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-[.07em] text-lp-muted">
            Daily limit left
          </div>
          <div className="mt-0.5 font-geist-mono text-[13px] font-bold tabular-nums text-lp-ink">
            {formatUsdcAmount(profile.daily_remaining_usdc)}
          </div>
          <div className="font-geist-mono text-[10px] text-lp-faint">
            of {formatUsdcAmount(profile.daily_limit_usdc)} USDC
          </div>
        </div>
        <div className="rounded-lp-tile bg-lp-raise p-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-[.07em] text-lp-muted">
            Disputes lost
          </div>
          <div className="mt-0.5 font-geist-mono text-[13px] font-bold tabular-nums text-lp-ink">
            {profile.disputes_lost}
          </div>
        </div>
        <div className="rounded-lp-tile bg-lp-raise p-2.5">
          <div className="text-[10px] font-semibold uppercase tracking-[.07em] text-lp-muted">
            Completion
          </div>
          <div className="mt-0.5 font-geist-mono text-[13px] font-bold tabular-nums text-lp-ink">
            {profile.completion_rate != null ? `${Math.round(profile.completion_rate * 100)}%` : '—'}
          </div>
        </div>
      </div>
    </div>
  )
}

export default function ProfilePage() {
  const wallet = useWallet()
  const auth = useAuth()
  const router = useRouter()
  const toast = useToast()

  const handleDisconnect = () => {
    wallet.disconnect()
    auth.logout()
    router.replace('/')
  }

  const address = auth.address ?? wallet.address
  const { balance } = useUsdcBalance(address)

  const handleCopyAddress = async () => {
    if (!address) return
    await navigator.clipboard.writeText(address)
    toast('Address copied', 'success')
  }

  return (
    <div className={`flex flex-col min-h-screen bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader title="Profile" />
      <main className="flex-1 px-[18px] pt-0.5 space-y-3.5 animate-lp-rise">
        <DarkHeroCard>
          <div className="font-geist-mono text-[11px] uppercase tracking-[.12em] opacity-55">
            Wallet balance
          </div>
          <div className="mt-1.5 font-geist-mono text-[38px] font-bold leading-none tracking-[-0.03em]">
            {balance != null ? formatUsdcBalance(balance) : '—'}{' '}
            <span className="text-[17px] opacity-60">USDC</span>
          </div>
          {address && (
            <button
              type="button"
              onClick={handleCopyAddress}
              aria-label="Copy wallet address"
              className="mt-3.5 flex items-center gap-2 font-geist-mono text-xs opacity-80"
            >
              <span className="flex h-4 w-4 items-center justify-center rounded bg-lp-usdc text-[9px] font-bold text-white">
                S
              </span>
              {shortAddress(address)} · Stellar
              <Copy size={13} strokeWidth={1.7} className="opacity-70" aria-hidden="true" />
            </button>
          )}
        </DarkHeroCard>

        <TierCard />

        <div className="overflow-hidden rounded-lp-card border border-lp-line bg-lp-surface">
          <a
            href="https://lp.lolipay.app"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-between px-4 py-[15px]"
          >
            <span className="flex items-center gap-3">
              <Settings size={19} strokeWidth={1.7} className="text-lp-ink" aria-hidden="true" />
              <span className="text-sm font-medium">Become a liquidity provider</span>
            </span>
            <span className="rounded-[7px] bg-lp-accent-soft px-2 py-[3px] text-[11px] font-semibold text-lp-accent-ink">
              Earn
            </span>
          </a>
        </div>

        <button
          type="button"
          onClick={handleDisconnect}
          className="w-full rounded-lp-cta bg-lp-danger-soft px-4 py-[15px] font-geist text-sm font-semibold text-lp-danger"
        >
          Disconnect wallet
        </button>

        <p className="text-center font-geist-mono text-[11px] text-lp-faint">
          non-custodial · keys never leave your device
        </p>
      </main>
    </div>
  )
}
