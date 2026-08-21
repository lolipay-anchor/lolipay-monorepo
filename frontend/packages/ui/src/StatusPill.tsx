import * as React from 'react'

export type PillTone = 'green' | 'amber' | 'danger' | 'accent' | 'neutral'
const tones: Record<PillTone, string> = {
  green: 'bg-lp-green-soft text-lp-green',
  amber: 'bg-lp-amber-soft text-lp-amber',
  danger: 'bg-lp-danger-soft text-lp-danger',
  accent: 'bg-lp-accent-soft text-lp-accent-ink',
  neutral: 'bg-lp-line-2 text-lp-ink-soft',
}

export interface StatusPillProps {
  tone: PillTone; pulse?: boolean; className?: string; children: React.ReactNode
}

export function StatusPill({ tone, pulse = false, className = '', children }: StatusPillProps) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-lp-pill px-2.5 py-1 text-xs font-semibold ${tones[tone]} ${className}`}>
      {pulse && <span data-testid="pill-dot" className="h-1.5 w-1.5 rounded-full bg-current animate-lp-pulse" />}
      {children}
    </span>
  )
}
