'use client'

import * as React from 'react'
import Link from 'next/link'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getLpMe,
  setAvailability,
  heartbeat,
  getAssignments,
  getLpEligibility,
  getLpEarnings,
} from '@lolipay/api-client'
import type { LpEarningsDayBar } from '@lolipay/api-client'
import { DarkHeroCard, StatCard, StatusPill, Skeleton, NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { AppHeader } from '@/components/AppHeader'
import { client } from '@/lib/client'
import { formatUSDC, formatUsdcNumber } from '@/lib/money'

const HEARTBEAT_INTERVAL_MS = 30_000

const EARNINGS_REFETCH_INTERVAL_MS = 30_000

function EarningsSparkline({ bars }: { bars: LpEarningsDayBar[] }) {
  const width = 70
  const height = 34
  const values = bars.map((b) => b.volume_usdc)
  const max = Math.max(...values, 0)

  const points = values.map((v, i) => {
    const x = values.length > 1 ? (i / (values.length - 1)) * (width - 4) + 2 : width / 2
    const y = max > 0 ? height - 4 - (v / max) * (height - 8) : height / 2
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      data-testid="earnings-sparkline"
      aria-hidden="true"
      className="flex-none"
    >
      <polyline
        points={points.join(' ')}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
        className="stroke-lp-green"
      />
    </svg>
  )
}

export default function DashboardPage() {
  const qc = useQueryClient()
  const { data: me, isLoading } = useQuery({
    queryKey: ['lpMe'],
    queryFn: () => getLpMe(client),
    staleTime: 30_000,
  })

  const { data: assignments } = useQuery({
    queryKey: ['assignments'],
    queryFn: () => getAssignments(client),
    staleTime: 30_000,
  })
  const { data: eligibility } = useQuery({
    queryKey: ['lpEligibility'],
    queryFn: () => getLpEligibility(client),
    staleTime: 30_000,
  })

  const {
    data: earnings,
    isLoading: earningsLoading,
    isError: earningsError,
  } = useQuery({
    queryKey: ['lpEarnings'],
    queryFn: () => getLpEarnings(client),
    enabled: me != null,
    staleTime: 30_000,
    refetchInterval: EARNINGS_REFETCH_INTERVAL_MS,
    refetchOnWindowFocus: true,
  })

  const [online, setOnline] = React.useState(false)
  const [toggling, setToggling] = React.useState(false)
  const [availError, setAvailError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (me != null) setOnline(me.online)
  }, [me?.online])

  React.useEffect(() => {
    if (!online) return
    const id = setInterval(() => {
      heartbeat(client).catch(() => {})
    }, HEARTBEAT_INTERVAL_MS)
    return () => clearInterval(id)
  }, [online])

  const handleToggle = async () => {
    const next = !online
    setToggling(true)
    setAvailError(null)
    try {
      await setAvailability(client, next)
      setOnline(next)
      qc.invalidateQueries({ queryKey: ['lpMe'] })
    } catch (err) {
      setAvailError(err instanceof Error ? err.message : 'Failed to update availability')
    } finally {
      setToggling(false)
    }
  }

  return (
    <div className={`flex min-h-screen flex-col bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader title="Dashboard" />
      <main className="flex-1 space-y-3.5 px-[18px] pt-1">
        {isLoading && (
          <p className="py-8 text-center text-sm text-lp-muted">Loading…</p>
        )}

        {me && (
          <>
            {}
            <DarkHeroCard>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="relative h-[9px] w-[9px] flex-none">
                    <span
                      className={`absolute inset-0 rounded-full ${online ? 'bg-lp-green' : 'bg-lp-paper/40'}`}
                    />
                    {online && (
                      <span
                        aria-hidden="true"
                        className="absolute inset-0 rounded-full bg-lp-green animate-lp-ring"
                      />
                    )}
                  </span>
                  <span className="font-geist text-[15px] font-semibold text-lp-paper">
                    {online ? 'Online — accepting orders' : 'Offline'}
                  </span>
                </div>

                {}
                <button
                  onClick={handleToggle}
                  disabled={toggling}
                  data-testid="availability-toggle"
                  aria-pressed={online}
                  aria-label={online ? 'Go offline' : 'Go online'}
                  className={[
                    'relative h-8 w-14 flex-none rounded-full transition-colors',
                    'focus:outline-none disabled:opacity-50',
                    online ? 'bg-lp-green' : 'bg-lp-paper/20',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'absolute top-[3px] h-[26px] w-[26px] rounded-full bg-white shadow transition-[left]',
                      online ? 'left-[27px]' : 'left-[3px]',
                    ].join(' ')}
                  />
                </button>
              </div>

              {availError && (
                <p className="mt-3 text-xs text-lp-paper" role="alert">
                  {availError}
                </p>
              )}

            </DarkHeroCard>

            {}
            {earningsLoading && (
              <div className="space-y-2.5" data-testid="earnings-loading">
                <div className="flex gap-2.5">
                  <Skeleton className="h-[68px] flex-1 rounded-lp-tile" />
                  <Skeleton className="h-[68px] flex-1 rounded-lp-tile" />
                </div>
                <Skeleton className="h-[66px] w-full rounded-lp-tile" />
              </div>
            )}

            {!earningsLoading && !earningsError && earnings && (
              <div className="space-y-2.5" data-testid="earnings-tiles">
                <div className="flex gap-2.5">
                  <StatCard
                    label="orders today"
                    value={<span data-testid="earnings-orders-today">{earnings.today_trades}</span>}
                    className="flex-1"
                  />
                  <StatCard
                    label="USDC earned"
                    value={
                      <span className="text-lp-green" data-testid="earnings-usdc-earned">
                        +{formatUsdcNumber(earnings.today_earned_usdc)}
                      </span>
                    }
                    className="flex-1"
                  />
                </div>
                <div className="flex items-center justify-between rounded-lp-tile border border-lp-line bg-lp-surface p-[15px]">
                  <div>
                    <div className="font-geist-mono text-[11px] uppercase tracking-[.08em] text-lp-muted">
                      Volume settled today
                    </div>
                    <div
                      className="mt-0.5 font-geist text-lg font-bold text-lp-ink"
                      data-testid="earnings-volume-today"
                    >
                      {formatUsdcNumber(earnings.today_volume_usdc)}
                    </div>
                  </div>
                  <EarningsSparkline bars={earnings.week_bars} />
                </div>
              </div>
            )}

            <StatCard label="Active assignments" value={assignments?.length ?? '—'} />

            {}
            <Link
              href="/stake"
              aria-label="View stake & eligibility"
              className="flex items-center gap-3.5 rounded-lp-tile bg-lp-ink p-[18px] text-lp-paper transition active:scale-[0.99]"
            >
              <span className="flex h-11 w-11 flex-none items-center justify-center rounded-[13px] bg-white/10">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z"
                    stroke="#fff"
                    strokeWidth="1.7"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M9 12l2 2 4-4"
                    stroke="#E6396B"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-geist-mono text-[11px] uppercase tracking-[.06em] text-lp-paper/55">
                  Collateral staked
                </div>
                <div className="mt-0.5 font-geist text-[22px] font-bold tracking-[-0.02em]">
                  {eligibility ? formatUSDC(BigInt(eligibility.staked)) : '—'}{' '}
                  <span className="text-[13px] font-normal text-lp-paper/60">USDC</span>
                </div>
              </div>
              {eligibility && (
                <StatusPill tone={eligibility.eligible ? 'green' : 'amber'}>
                  {eligibility.eligible ? 'Eligible' : 'Not eligible'}
                </StatusPill>
              )}
            </Link>

            {}
            {!earningsLoading && !earningsError && earnings && (
              <p
                className="px-1 text-center text-[11px] text-lp-muted"
                data-testid="earnings-all-time"
              >
                All time: {earnings.all_time_trades} trade
                {earnings.all_time_trades === 1 ? '' : 's'} ·{' '}
                {formatUsdcNumber(earnings.all_time_earned_usdc)} USDC earned
              </p>
            )}
          </>
        )}
      </main>
    </div>
  )
}
