import * as React from 'react'
export function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`bg-lp-surface rounded-lp-card border border-lp-line p-4 ${className}`}>
      {children}
    </div>
  )
}
