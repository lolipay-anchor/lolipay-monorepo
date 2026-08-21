import * as React from 'react'

export interface ActionTileProps {
  icon: React.ReactNode; label: string; sub?: string
  variant?: 'light' | 'primary'; onClick?: () => void; className?: string
}

export function ActionTile({ icon, label, sub, variant = 'light', onClick, className = '' }: ActionTileProps) {
  const look = variant === 'primary'
    ? 'bg-lp-ink text-lp-paper'
    : 'border border-lp-line bg-lp-surface text-lp-ink'
  return (
    <button type="button" onClick={onClick}
      className={`flex flex-col items-center gap-[9px] rounded-[18px] px-1.5 py-4 text-center transition active:scale-[0.98] ${look} ${className}`}>
      <span aria-hidden="true">{icon}</span>
      <span className="text-[13px] font-semibold leading-tight">
        {label}
        {sub && <span className={`block text-[11px] font-normal ${variant === 'primary' ? 'text-lp-paper/60' : 'text-lp-muted'}`}>{sub}</span>}
      </span>
    </button>
  )
}
