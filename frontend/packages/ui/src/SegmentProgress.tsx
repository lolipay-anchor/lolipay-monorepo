import * as React from 'react'

export interface SegmentProgressProps {
  total?: number; done: number; className?: string
}

export function SegmentProgress({ total = 4, done, className = '' }: SegmentProgressProps) {
  const now = Math.min(Math.max(done, 0), total)
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={now} className={`flex gap-1 ${className}`}>
      {Array.from({ length: total }, (_, i) => (
        <span key={i} className={`h-1 flex-1 rounded-full ${i < now ? 'bg-lp-accent' : 'bg-lp-line-2'}`} />
      ))}
    </div>
  )
}
