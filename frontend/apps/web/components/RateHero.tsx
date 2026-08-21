'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { getRate } from '@lolipay/api-client'
import { DarkHeroCard } from '@lolipay/ui'
import { useAuth } from '@/app/providers'
import { client } from '@/lib/client'
import { formatIDR } from '@/lib/money'
import { formatUsdcBalance } from '@/lib/balance'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'

interface RateDelta {
  pct: number
  up: boolean
}

export function RateHero() {
  const auth = useAuth()
  const { data, isPending, isError } = useQuery({
    queryKey: ['rate'],
    queryFn: () => getRate(client),
    refetchInterval: 12000,
  })

  const { balance } = useUsdcBalance(auth.address)

  const prevRateRef = React.useRef<number | null>(null)
  const [delta, setDelta] = React.useState<RateDelta | null>(null)

  React.useEffect(() => {
    if (!data) return
    const current = parseFloat(data.rate)
    if (Number.isNaN(current)) return
    const prev = prevRateRef.current
    if (prev !== null && prev !== current) {
      const pct = ((current - prev) / prev) * 100
      setDelta({ pct: Math.abs(pct), up: pct >= 0 })
    }
    prevRateRef.current = current
  }, [data])

  const rateNum = data ? parseFloat(data.rate) : null
  const balanceIdr =
    balance != null && rateNum != null ? formatIDR(Number(balance) * rateNum) : null

  return (
    <DarkHeroCard>
      <div className="flex items-center justify-between">
        <span className="font-geist-mono text-[11px] uppercase tracking-[.14em] opacity-60">
          USDC / IDR
        </span>
        <span className="flex items-center gap-1.5 text-[11px] font-semibold opacity-85">
          <span className="h-1.5 w-1.5 animate-lp-pulse rounded-full bg-lp-accent" />
          LIVE
        </span>
      </div>

      {isPending && !data && (
        <p className="mt-3 font-geist-mono text-[44px] font-bold leading-none tracking-[-0.03em] tabular-nums opacity-40">
          —
        </p>
      )}
      {isError && !data && (
        <p className="mt-3 text-xl opacity-60">rate unavailable</p>
      )}
      {data && (
        <p className="mt-3 font-geist-mono text-[44px] font-bold leading-none tracking-[-0.03em] tabular-nums">
          {formatIDR(Math.round(rateNum!))}
        </p>
      )}

      <div className="mt-3.5 flex items-center justify-between">
        <span className="text-xs opacity-55">Rate · incl. spread · refreshes every 12s</span>
        {delta && (
          <span
            className={`font-geist-mono text-xs rounded-lg px-2 py-[3px] ${
              delta.up ? 'bg-lp-green-soft text-lp-green' : 'bg-lp-amber-soft text-lp-amber'
            }`}
          >
            {delta.up ? '▲' : '▼'} {delta.pct.toFixed(2)}%
          </span>
        )}
      </div>

      {balance != null && (
        <>
          <div className="mt-4 h-px bg-white/10" />
          <div className="mt-3.5 flex items-center gap-2.5">
            <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-lg bg-lp-usdc font-geist text-xs font-bold text-white">
              $
            </span>
            <div>
              <div className="font-geist-mono text-[15px] font-bold tabular-nums">
                {formatUsdcBalance(balance)} USDC
              </div>
              <div className="mt-0.5 text-xs opacity-55">≈ {balanceIdr ?? '—'} in IDR</div>
            </div>
          </div>
        </>
      )}
    </DarkHeroCard>
  )
}
