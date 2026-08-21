'use client'

import * as React from 'react'
import { Button } from '@lolipay/ui'

interface NotAuthorizedProps {
  onDisconnect: () => void
}

export function NotAuthorized({ onDisconnect }: NotAuthorizedProps) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-lp-paper px-6">
      <div className="w-full max-w-xs flex flex-col items-center gap-8">
        <div className="flex items-center gap-2">
          <h1 className="font-geist text-4xl font-bold tracking-[-0.02em] text-lp-ink">
            lolipay
          </h1>
          <span className="font-geist-mono text-xs font-bold uppercase tracking-[.08em] text-lp-ink bg-lp-line-2 rounded-md px-2 py-1">
            admin
          </span>
        </div>

        <p className="text-sm text-lp-danger text-center leading-relaxed font-semibold">
          Not authorized — connect an admin wallet.
        </p>

        <p className="text-xs text-lp-muted text-center">
          This panel is restricted to admin wallets only.
        </p>

        <div className="w-full">
          <Button onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
      </div>
    </div>
  )
}
