import * as React from 'react'
export function WalletPill({ address, online = false }: { address: string; online?: boolean }) {
  const short = address.slice(0, 4) + '…' + address.slice(-4)
  return (
    <div className="inline-flex items-center gap-1.5 bg-lp-surface border border-lp-line rounded-full px-3 py-1.5 text-xs font-semibold text-lp-ink font-geist-mono">
      {online && <span className="w-2 h-2 rounded-full bg-lp-green" />}
      {short}
    </div>
  )
}
