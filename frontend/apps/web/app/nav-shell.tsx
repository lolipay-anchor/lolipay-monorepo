'use client'

import * as React from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { BottomNav, type BottomNavItem } from '@lolipay/ui'
import { Home, ArrowDownUp, ClipboardList, User } from 'lucide-react'

type Tab = 'home' | 'trade' | 'orders' | 'profile'

const ROUTES: Record<Tab, string> = {
  home: '/',
  trade: '/buy',
  orders: '/orders',
  profile: '/profile',
}

const ICON_PROPS = { size: 20, strokeWidth: 1.9 }

const ITEMS: BottomNavItem[] = [
  { key: 'home', label: 'Home', icon: <Home {...ICON_PROPS} /> },
  { key: 'trade', label: 'Trade', icon: <ArrowDownUp {...ICON_PROPS} /> },
  { key: 'orders', label: 'Orders', icon: <ClipboardList {...ICON_PROPS} /> },
  { key: 'profile', label: 'Profile', icon: <User {...ICON_PROPS} /> },
]

function pathnameToTab(pathname: string): Tab {
  if (pathname.startsWith('/orders')) return 'orders'
  if (pathname.startsWith('/buy') || pathname.startsWith('/sell')) return 'trade'
  if (pathname.startsWith('/profile')) return 'profile'
  return 'home'
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
