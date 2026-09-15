'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { useWallet } from '@lolipay/wallet'
import { WalletPill } from '@lolipay/ui'
import { useAuth } from '@/app/providers'

interface AppHeaderProps {
  title?: string
  showBack?: boolean
}

export function AppHeader({ title, showBack = false }: AppHeaderProps) {
  const auth = useAuth()
  const wallet = useWallet()
  const router = useRouter()

  const handleSignOut = () => {
    wallet.disconnect()
    auth.logout()
    router.replace('/')
  }

  return (
    <div className="border-b border-lp-line bg-lp-paper">
      <header className="flex items-center gap-3 px-[18px] py-3">
        {}
        <div className="min-w-0 flex-1">
          {showBack ? (
            <button
              onClick={() => router.back()}
              className="-m-2.5 flex items-center gap-[5px] p-2.5 font-geist text-sm font-semibold text-lp-ink"
              aria-label="Go back"
            >
              <ArrowLeft size={18} strokeWidth={2.2} />
              <span>{title}</span>
            </button>
          ) : (
            <Link href="/" className="flex min-w-0 items-center gap-2">
              <span className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[9px] bg-lp-ink">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="9" r="6.4" fill="#E6396B" />
                  <rect x="10.6" y="13.5" width="2.8" height="8.2" rx="1.4" fill="#E6396B" />
                </svg>
              </span>
              <span className="truncate font-geist text-lg font-bold tracking-[-0.02em] text-lp-ink">
                lolipay
              </span>
              <span className="font-geist-mono text-[10px] font-bold uppercase tracking-[.08em] text-lp-ink bg-lp-line-2 rounded-md px-1.5 py-0.5">
                admin
              </span>
            </Link>
          )}
        </div>

        {}
        {auth.address && (
          <div className="flex shrink-0 items-center gap-2">
            <WalletPill address={auth.address} online />
            <button
              onClick={handleSignOut}
              className="whitespace-nowrap rounded-lg px-2 py-1 font-geist text-xs font-semibold text-lp-muted hover:text-lp-danger"
              aria-label="Disconnect wallet"
            >
              Sign out
            </button>
          </div>
        )}
      </header>

      {}
      {title && (
        <div className="px-[18px] pb-3">
          <h1 className="font-geist text-2xl font-bold text-lp-ink">{title}</h1>
        </div>
      )}
    </div>
  )
}
