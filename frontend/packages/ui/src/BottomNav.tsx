import * as React from 'react'

export const NAV_CLEARANCE_CLASS = 'pb-[calc(84px+env(safe-area-inset-bottom))]'

export interface BottomNavItem { key: string; label: string; icon: React.ReactNode }

export interface BottomNavProps {
  items: BottomNavItem[]; active: string; onSelect: (key: string) => void; className?: string
}

export function BottomNav({ items, active, onSelect, className = '' }: BottomNavProps) {
  return (
    <nav className={`flex items-center justify-around border-t border-lp-line bg-lp-paper px-2 pb-[max(10px,env(safe-area-inset-bottom))] pt-2 ${className}`}>
      {items.map((it) => {
        const isActive = it.key === active
        return (
          <button key={it.key} type="button" onClick={() => onSelect(it.key)}
            aria-current={isActive ? 'page' : undefined}
            className={`flex min-w-16 flex-col items-center gap-1 rounded-xl px-3 py-1.5 text-[10.5px] font-semibold ${isActive ? 'text-lp-accent-ink' : 'text-lp-muted'}`}>
            <span aria-hidden="true">{it.icon}</span>
            {it.label}
          </button>
        )
      })}
    </nav>
  )
}
