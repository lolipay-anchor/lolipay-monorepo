'use client'

import * as React from 'react'
import { Lock, ShieldCheck, Undo2 } from 'lucide-react'
import type { OrderStatus } from '@lolipay/api-client'
import { escrowContractUrl } from '@/lib/explorer'

export function EscrowLocked({ status }: { status: OrderStatus }) {
  const locked = status === 'FUNDED' || status === 'FIAT_PAID' || status === 'DISPUTED'
  const released = status === 'RELEASED'
  const refunded = status === 'REFUNDED'
  if (!locked && !released && !refunded) return null

  const Icon = released ? ShieldCheck : refunded ? Undo2 : Lock
  const title = released
    ? 'USDC released from escrow'
    : refunded
      ? 'USDC refunded from escrow'
      : 'Funds locked in escrow'
  const body = locked
    ? 'Held by the on-chain contract — not lolipay.'
    : 'Settled on-chain by the Soroban escrow contract.'
  const url = escrowContractUrl()

  return (
    <div className="flex items-center gap-3 rounded-lp-card border border-lp-green/25 bg-lp-green-soft px-4 py-[14px]">
      <Icon size={22} strokeWidth={1.8} className="flex-none text-lp-green" aria-hidden="true" />
      <div className="flex-1">
        <p className="text-[13.5px] font-semibold text-lp-ink">{title}</p>
        <p className="mt-px text-xs text-lp-ink-soft">{body}</p>
      </div>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="font-geist-mono text-[11px] font-semibold text-lp-green"
        >
          view ↗
        </a>
      )}
    </div>
  )
}
