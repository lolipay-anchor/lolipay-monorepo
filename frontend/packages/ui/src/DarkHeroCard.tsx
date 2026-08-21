import * as React from 'react'

export interface DarkHeroCardProps { className?: string; children: React.ReactNode }

export function DarkHeroCard({ className = '', children }: DarkHeroCardProps) {
  return (
    <div data-testid="dark-hero" className={`relative overflow-hidden rounded-lp-card bg-lp-ink px-5 py-[18px] text-lp-paper ${className}`}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full opacity-50"
        style={{ background: 'radial-gradient(circle, #E6396B 0%, transparent 70%)' }}
      />
      <div className="relative">{children}</div>
    </div>
  )
}
