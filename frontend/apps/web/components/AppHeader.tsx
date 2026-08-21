'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { useAuth } from '@/app/providers'
import { shortAddress } from '@/lib/format'
import { NotificationBell } from '@/components/NotificationBell'

interface AppHeaderProps {
  title?: string

  showBack?: boolean
}

export function AppHeader({ title, showBack = false }: AppHeaderProps) {
  const auth = useAuth()
  const router = useRouter()

  return (
    <header className="flex flex-none items-center gap-2.5 px-[18px] pb-3 pt-2">
      {}
      <div className="flex min-w-0 flex-1 items-center">
        {showBack ? (
          <button
            onClick={() => router.back()}
            aria-label="Go back"
            className="-m-2.5 flex items-center gap-[5px] border-none bg-none p-2.5 font-geist text-sm font-semibold text-lp-ink"
          >
            <ArrowLeft size={18} strokeWidth={2.2} />
            <span>{title}</span>
          </button>
        ) : (
          <Link href="/" className="flex items-center gap-2">
            <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[9px] bg-lp-accent shadow-[0_3px_8px_-2px_#E6396B]">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="9" r="6.4" fill="#fff" />
                <rect x="10.6" y="13.5" width="2.8" height="8.2" rx="1.4" fill="#fff" />
              </svg>
            </span>
            <span className="font-geist text-[21px] font-bold tracking-[-0.02em] text-lp-ink">
              lolipay
            </span>
          </Link>
        )}
      </div>

      {}
      {!showBack && title && (
        <span className="font-geist text-lg font-bold text-lp-ink">{title}</span>
      )}

      {}
      <div className="flex flex-1 items-center justify-end gap-3">
        <NotificationBell />
        {auth.address && (
          <Link
            href="/profile"
            aria-label="Account and settings"
            className="inline-flex shrink-0 whitespace-nowrap h-[38px] items-center gap-1.5 rounded-full border border-lp-line bg-lp-surface px-[11px] font-geist-mono text-xs font-semibold text-lp-ink focus:outline-none"
          >
            <span className="h-[7px] w-[7px] rounded-full bg-lp-green" />
            {shortAddress(auth.address)}
          </Link>
        )}
      </div>
    </header>
  )
}
