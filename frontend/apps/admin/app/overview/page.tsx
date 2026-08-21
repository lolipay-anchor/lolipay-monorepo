'use client'

import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { getMetricsOverview } from '@lolipay/api-client'
import type { MetricsOverview, MetricsRange } from '@lolipay/api-client'
import { DarkHeroCard, StatCard, Segmented, Skeleton, NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { AppHeader } from '@/components/AppHeader'
import { client } from '@/lib/client'

const RANGES: MetricsRange[] = ['24h', '7d', '30d']

const RANGE_LABEL: Record<MetricsRange, string> = {
  '24h': 'Last 24h',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
}

const FLOW_LABEL: Record<string, string> = {
  TOP_UP: 'Buy USDC',
  WITHDRAW: 'Sell USDC',
}
const FLOW_BAR_CLASS: Record<string, string> = {
  TOP_UP: 'bg-lp-ink',
  WITHDRAW: 'bg-lp-green',
}
const FLOW_DOT_CLASS: Record<string, string> = {
  TOP_UP: 'bg-lp-ink',
  WITHDRAW: 'bg-lp-green',
}

function formatUsdc(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatSettleSecs(secs: number | null): string {
  if (secs == null) return '—'
  const s = Math.max(0, Math.round(secs))
  const m = Math.floor(s / 60)
  const r = s % 60
  return m === 0 ? `${r}s` : `${m}m ${r}s`
}

function truncateAddress(addr: string | null): string {
  if (!addr) return '—'
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function DailyVolumeChart({ bars }: { bars: MetricsOverview['daily_bars'] }) {
  if (bars.length === 0) {
    return (
      <p className="text-xs text-lp-muted py-6 text-center" data-testid="overview-daily-bars-empty">
        No settled volume in this range yet.
      </p>
    )
  }

  const max = Math.max(...bars.map((b) => b.volume_usdc), 0.0001)

  return (
    <div className="flex items-end justify-between gap-2 h-[104px]" data-testid="overview-daily-bars">
      {bars.map((bar) => {
        const pct = Math.max((bar.volume_usdc / max) * 100, bar.volume_usdc > 0 ? 3 : 0)
        const day = new Date(bar.date + 'T00:00:00Z')
        const dayLabel = Number.isNaN(day.getTime())
          ? bar.date
          : day.toLocaleDateString('en-US', { weekday: 'narrow' })
        return (
          <div
            key={bar.date}
            className="flex flex-1 flex-col items-center justify-end gap-1.5 h-full"
            data-testid={`daily-bar-${bar.date}`}
            title={`${bar.date}: ${formatUsdc(bar.volume_usdc)} USDC`}
          >
            <div
              className="w-full rounded-t-md bg-lp-line-2"
              style={{ height: `${pct}%` }}
            />
            <span className="font-geist-mono text-[10px] text-lp-faint">{dayLabel}</span>
          </div>
        )
      })}
    </div>
  )
}

function FlowMix({ flowMix }: { flowMix: MetricsOverview['flow_mix'] }) {
  const total = flowMix.reduce((sum, f) => sum + f.volume_usdc, 0)

  if (flowMix.length === 0 || total <= 0) {
    return (
      <p className="text-xs text-lp-muted py-2" data-testid="overview-flow-mix-empty">
        No settled orders in this range yet.
      </p>
    )
  }

  return (
    <div data-testid="overview-flow-mix">
      <div className="flex h-3 gap-0.5 overflow-hidden rounded-full">
        {flowMix.map((f) => (
          <div
            key={f.flow}
            className={FLOW_BAR_CLASS[f.flow] ?? 'bg-lp-muted'}
            style={{ width: `${(f.volume_usdc / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="mt-3.5 flex flex-col gap-2.5">
        {flowMix.map((f) => (
          <div key={f.flow} className="flex items-center justify-between text-[13px]" data-testid={`flow-mix-${f.flow}`}>
            <span className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-sm ${FLOW_DOT_CLASS[f.flow] ?? 'bg-lp-muted'}`} />
              {FLOW_LABEL[f.flow] ?? f.flow}
            </span>
            <span className="font-geist-mono font-semibold text-lp-ink">
              {Math.round((f.volume_usdc / total) * 100)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function TopLps({ topLps }: { topLps: MetricsOverview['top_lps'] }) {
  if (topLps.length === 0) {
    return (
      <p className="text-xs text-lp-muted py-2" data-testid="overview-top-lps-empty">
        No settled trades in this range yet.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="overview-top-lps">
      {topLps.map((lp, i) => (
        <div key={lp.lp_id} className="flex items-center gap-2.5" data-testid={`top-lp-${lp.lp_id}`}>
          <span className="w-3.5 font-geist-mono text-xs text-lp-faint">{i + 1}</span>
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-lp-tile bg-lp-ink font-geist text-[13px] font-bold text-lp-paper">
            {lp.address ? lp.address[1]?.toUpperCase() : '?'}
          </span>
          <div className="min-w-0 flex-1">
            <div className="font-geist-mono text-[13px] font-semibold text-lp-ink truncate">
              {truncateAddress(lp.address)}
            </div>
            <div className="font-geist-mono text-[11px] text-lp-muted">{lp.trades} trades</div>
          </div>
          <span className="font-geist text-sm font-bold text-lp-ink">{formatUsdc(lp.volume_usdc)}</span>
        </div>
      ))}
    </div>
  )
}

function OverviewContent() {
  const [range, setRange] = React.useState<MetricsRange>('24h')

  const { data, isLoading, error } = useQuery({
    queryKey: ['adminMetricsOverview', range],
    queryFn: () => getMetricsOverview(client, range),
  })

  return (
    <div className="flex flex-col gap-3.5" data-testid="overview-page">
      <div className="flex items-center justify-between">
        <Segmented
          options={RANGES}
          value={range}
          onChange={(v) => setRange(v as MetricsRange)}
        />
      </div>

      {isLoading && (
        <div className="space-y-3.5" data-testid="overview-loading">
          <Skeleton className="h-[110px] w-full rounded-lp-card" />
          <div className="grid grid-cols-2 gap-2.5">
            <Skeleton className="h-[84px] rounded-lp-tile" />
            <Skeleton className="h-[84px] rounded-lp-tile" />
            <Skeleton className="h-[84px] rounded-lp-tile" />
            <Skeleton className="h-[84px] rounded-lp-tile" />
          </div>
        </div>
      )}

      {error && !isLoading && (
        <p className="text-lp-danger text-sm text-center py-8" data-testid="overview-error">
          Failed to load metrics. Please try again.
        </p>
      )}

      {data && !isLoading && (
        <>
          {}
          <DarkHeroCard>
            <div className="flex items-center justify-between">
              <span className="font-geist-mono text-[11px] uppercase tracking-[.12em] text-lp-paper/55">
                Volume · {RANGE_LABEL[data.range]}
              </span>
            </div>
            <div
              className="mt-2 font-geist text-[36px] font-bold leading-none tracking-[-0.03em]"
              data-testid="overview-volume"
            >
              {formatUsdc(data.volume_usdc)} <span className="text-base font-semibold text-lp-paper/60">USDC</span>
            </div>
            <div className="mt-1.5 text-xs text-lp-paper/55" data-testid="overview-orders-count">
              {data.orders_count} order{data.orders_count === 1 ? '' : 's'} settled
            </div>
          </DarkHeroCard>

          {}
          <div className="grid grid-cols-2 gap-2.5">
            <StatCard
              label="Avg settle"
              value={<span data-testid="overview-avg-settle">{formatSettleSecs(data.avg_settle_secs)}</span>}
            />
            <StatCard
              label="Platform fees"
              value={<span className="text-lp-green" data-testid="overview-fees">+{formatUsdc(data.fees_usdc)}</span>}
            />
            {}
            <Link href="/orders?status=DISPUTED" className="col-span-2" data-testid="overview-disputes-link">
              <StatCard
                label="Open disputes"
                value={
                  <span
                    className={data.open_disputes > 0 ? 'text-lp-danger' : 'text-lp-ink'}
                    data-testid="overview-disputes"
                  >
                    {data.open_disputes}
                  </span>
                }
              />
            </Link>
          </div>

          {}
          <div className="rounded-lp-card border border-lp-line bg-lp-surface p-[18px]">
            <div className="mb-4 flex items-center justify-between">
              <span className="text-[13px] font-semibold text-lp-ink">Daily volume</span>
              <span className="font-geist-mono text-[11px] text-lp-muted">USDC settled</span>
            </div>
            <DailyVolumeChart bars={data.daily_bars} />
          </div>

          {}
          <div className="rounded-lp-card border border-lp-line bg-lp-surface p-[18px]">
            <div className="mb-3.5 text-[13px] font-semibold text-lp-ink">Flow mix</div>
            <FlowMix flowMix={data.flow_mix} />
          </div>

          {}
          <div className="rounded-lp-card border border-lp-line bg-lp-surface p-[18px]">
            <div className="mb-3 text-[13px] font-semibold text-lp-ink">Top providers</div>
            <TopLps topLps={data.top_lps} />
          </div>
        </>
      )}
    </div>
  )
}

export default function OverviewPage() {
  return (
    <div className={`flex flex-col min-h-screen bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader title="Overview" />
      <main className="flex-1 px-[18px] pt-1">
        <OverviewContent />
      </main>
    </div>
  )
}
