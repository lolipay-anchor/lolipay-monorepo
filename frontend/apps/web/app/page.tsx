'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { ArrowDown, ArrowUp, ShieldCheck, Lock, Zap } from 'lucide-react'
import { ActionTile, NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { AppHeader } from '@/components/AppHeader'
import { RateHero } from '@/components/RateHero'
import { ActiveOrderCard } from '@/components/ActiveOrderCard'

const TRUST_ITEMS: Array<{ Icon: typeof ShieldCheck; label: string }> = [
  { Icon: ShieldCheck, label: 'Non-custodial' },
  { Icon: Lock, label: 'Escrow secured' },
  { Icon: Zap, label: 'Paid in ~2 min' },
]

export default function Home() {
  const router = useRouter()

  return (
    <div className={`flex min-h-screen flex-col bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader />

      <main className="flex flex-1 flex-col gap-3.5 px-[18px] pt-0.5 animate-lp-rise">
        {}
        <RateHero />

        {}
        <div className="grid grid-cols-2 gap-2.5">
          <ActionTile
            icon={
              <span className="flex h-10 w-10 items-center justify-center rounded-[13px] bg-lp-accent-soft">
                <ArrowDown size={19} strokeWidth={2.2} className="text-lp-accent-ink" aria-hidden="true" />
              </span>
            }
            label="Buy"
            onClick={() => router.push('/buy')}
          />
          <ActionTile
            icon={
              <span className="flex h-10 w-10 items-center justify-center rounded-[13px] bg-lp-line-2">
                <ArrowUp size={19} strokeWidth={2.2} className="text-lp-ink" aria-hidden="true" />
              </span>
            }
            label="Sell"
            onClick={() => router.push('/sell')}
          />
        </div>

        {}
        <ActiveOrderCard />

        {}
        <div className="mt-0.5 flex gap-2">
          {TRUST_ITEMS.map(({ Icon, label }) => (
            <div
              key={label}
              className="flex-1 rounded-lp-tile border border-lp-line-2 bg-lp-raise px-2.5 py-3 text-center"
            >
              <Icon size={18} strokeWidth={1.7} className="mx-auto mb-[5px] text-lp-ink" aria-hidden="true" />
              <div className="text-[11px] font-semibold leading-[1.25]">{label}</div>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}
