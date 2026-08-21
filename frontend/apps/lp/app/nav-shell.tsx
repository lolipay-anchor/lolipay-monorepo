'use client'

import * as React from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { BottomNav, type BottomNavItem } from '@lolipay/ui'
import { LayoutGrid, ClipboardList, Landmark, ShieldCheck } from 'lucide-react'

type Tab = 'dashboard' | 'assignments' | 'payment-methods' | 'stake'

const ROUTES: Record<Tab, string> = {
  dashboard: '/',
  assignments: '/assignments',
  'payment-methods': '/payment-methods',
  stake: '/stake',
}

const ICON_PROPS = { size: 20, strokeWidth: 1.9 }

const ITEMS: BottomNavItem[] = [
  { key: 'dashboard', label: 'Dashboard', icon: <LayoutGrid {...ICON_PROPS} /> },
  { key: 'assignments', label: 'Assign', icon: <ClipboardList {...ICON_PROPS} /> },
  { key: 'payment-methods', label: 'Rails', icon: <Landmark {...ICON_PROPS} /> },
  { key: 'stake', label: 'Stake', icon: <ShieldCheck {...ICON_PROPS} /> },
]

function pathnameToTab(pathname: string): Tab {
  if (pathname.startsWith('/payment-methods')) return 'payment-methods'
  if (pathname.startsWith('/assignments')) return 'assignments'
  if (pathname.startsWith('/stake')) return 'stake'
  return 'dashboard'
}

export function NavShell() {
  const pathname = usePathname()
  const router = useRouter()
  const active = pathnameToTab(pathname)

  return (
    <BottomNav
      items={ITEMS}
      active={active}
      onSelect={(key) => router.push(ROUTES[key as Tab])}
      className="fixed bottom-0 inset-x-0"
    />
  )
}
