import * as React from 'react'
export function RateChip({ rate, secondsLeft }: { rate: string; secondsLeft: number }) {
  const m = Math.floor(secondsLeft/60), s = (secondsLeft%60).toString().padStart(2,'0')
  return <div className="inline-flex items-center gap-1 text-xs font-semibold text-lp-accent-ink
    bg-lp-surface border border-lp-line rounded-[10px] px-2.5 py-1.5 tabular-nums">
    🔒 {rate} · {m}:{s}</div>
}
