'use client'

import * as React from 'react'
import { NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { AppHeader } from '@/components/AppHeader'
import { BuyForm } from '@/components/BuyForm'

export default function BuyPage() {
  return (
    <div className={`flex min-h-screen flex-col bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader showBack title="Buy USDC" />

      <main className="flex-1 px-[18px] pt-1 animate-lp-rise">
        <BuyForm />
      </main>
    </div>
  )
}
