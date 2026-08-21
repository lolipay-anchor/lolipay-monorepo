import * as React from 'react'

export interface StatCardProps {
  label: string; value: React.ReactNode; sub?: React.ReactNode; className?: string
}

export function StatCard({ label, value, sub, className = '' }: StatCardProps) {
  return (
    <div className={`rounded-lp-tile border border-lp-line bg-lp-surface p-3.5 ${className}`}>
      <div className="text-[10.5px] font-semibold uppercase tracking-[0.09em] text-lp-muted">{label}</div>
      <div className="mt-1 font-geist-mono text-lg font-bold tabular-nums text-lp-ink">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-lp-ink-soft">{sub}</div>}
    </div>
  )
}
