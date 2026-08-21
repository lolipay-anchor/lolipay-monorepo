'use client'

import * as React from 'react'

export interface QuoteRow {
  label: string
  value: string

  strong?: boolean
}

export function QuoteBreakdown({ rows }: { rows: QuoteRow[] }) {
  return (
    <div className="flex flex-col gap-[9px]">
      {rows.map((r, i) => (
        <div
          key={i}
          className={
            'flex items-center justify-between text-[13px] ' +
            (r.strong ? 'border-t border-dashed border-lp-line pt-[9px]' : '')
          }
        >
          <span className={r.strong ? 'font-semibold text-lp-ink' : 'text-lp-muted'}>{r.label}</span>
          <span
            className={
              'tabular-nums ' +
              (r.strong
                ? 'font-geist text-[20px] font-bold tracking-[-0.01em] text-lp-accent-ink'
                : 'font-geist-mono font-medium text-lp-ink')
            }
            data-testid={r.strong ? 'quote-net' : undefined}
          >
            {r.value}
          </span>
        </div>
      ))}
    </div>
  )
}
