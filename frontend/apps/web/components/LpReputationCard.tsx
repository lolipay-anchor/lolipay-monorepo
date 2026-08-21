'use client'

import * as React from 'react'
import { Handshake } from 'lucide-react'
import type { LpReputation } from '@lolipay/api-client'

export function LpReputationCard({ rep }: { rep: LpReputation }) {
  const pct = rep.completion_rate != null ? Math.round(rep.completion_rate * 100) : null
  const since = new Date(rep.member_since).toLocaleDateString('id-ID', {
    year: 'numeric',
    month: 'short',
  })

  return (
    <div className="flex items-center justify-between rounded-lp-card border border-lp-line bg-lp-surface p-4">
      <div className="flex items-center gap-2.5">
        <span className="relative flex h-9 w-9 flex-none items-center justify-center rounded-full bg-lp-accent-soft">
          <Handshake size={16} strokeWidth={1.9} className="text-lp-accent-ink" aria-hidden="true" />
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-lp-surface ${rep.online ? 'bg-lp-green' : 'bg-lp-muted'}`}
            aria-label={rep.online ? 'Online' : 'Offline'}
          />
        </span>
        <div>
          <p className="text-[13.5px] font-semibold text-lp-ink">Liquidity Provider</p>
          <p className="text-xs text-lp-muted">Member since {since}</p>
        </div>
      </div>
      <div className="text-right">
        <p className="font-geist-mono text-sm font-bold text-lp-ink" data-testid="lp-completion">
          {pct != null ? `${pct}%` : 'New LP'}
        </p>
        <p className="text-xs text-lp-muted">
          {rep.completed_trades} {rep.completed_trades === 1 ? 'trade' : 'trades'}
        </p>
      </div>
    </div>
  )
}
