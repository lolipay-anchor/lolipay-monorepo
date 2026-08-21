'use client'

import * as React from 'react'
import { useRouter, usePathname } from 'next/navigation'
import { BottomNav, type BottomNavItem } from '@lolipay/ui'
import { BarChart3, Users, ClipboardList, Settings } from 'lucide-react'

type Tab = 'overview' | 'lps' | 'orders' | 'config'

const ROUTES: Record<Tab, string> = {
  overview: '/overview',
  lps: '/',
  orders: '/orders',
  config: '/config',
}

const ICON_PROPS = { size: 20, strokeWidth: 1.9 }

const ITEMS: BottomNavItem[] = [
  { key: 'overview', label: 'Overview', icon: <BarChart3 {...ICON_PROPS} /> },
  { key: 'lps', label: 'LPs', icon: <Users {...ICON_PROPS} /> },
  { key: 'orders', label: 'Orders', icon: <ClipboardList {...ICON_PROPS} /> },
  { key: 'config', label: 'Config', icon: <Settings {...ICON_PROPS} /> },
]

function pathnameToTab(pathname: string): Tab {
  if (pathname.startsWith('/overview')) return 'overview'
  if (pathname.startsWith('/orders')) return 'orders'
  if (pathname.startsWith('/config')) return 'config'
  return 'lps'
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
