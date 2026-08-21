'use client'

import * as React from 'react'
import { NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { AppHeader } from '@/components/AppHeader'
import { SellForm } from '@/components/SellForm'

export default function SellPage() {
  return (
    <div className={`flex min-h-screen flex-col bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader showBack title="Sell USDC" />

      <main className="flex-1 px-[18px] pt-1 animate-lp-rise">
        <SellForm />
      </main>
    </div>
  )
}
