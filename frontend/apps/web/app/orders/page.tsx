'use client'

import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { getOrders } from '@lolipay/api-client'
import type { Order, Flow } from '@lolipay/api-client'
import { SkeletonList, StatusPill, NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { ArrowDown, ArrowUp, ClipboardList } from 'lucide-react'
import { useAuth } from '@/app/providers'
import { client } from '@/lib/client'
import { formatUSDC } from '@/lib/money'
import { isTerminal } from '@/lib/steps'
import { timeAgo, pillFor } from '@/lib/format'
import { ConnectGate } from '@/components/ConnectGate'
import { AppHeader } from '@/components/AppHeader'

const FLOW_ICON: Record<Flow, { Icon: typeof ArrowDown; tile: string; icon: string }> = {
  TOP_UP: { Icon: ArrowDown, tile: 'bg-lp-green-soft', icon: 'text-lp-green' },
  WITHDRAW: { Icon: ArrowUp, tile: 'bg-lp-line-2', icon: 'text-lp-ink' },
}

const FLOW_TITLE: Record<Flow, string> = {
  TOP_UP: 'Buy USDC',
  WITHDRAW: 'Sell USDC',
}

function OrderRow({ order }: { order: Order }) {
  const { tone, label } = pillFor(order.status, order.flow)
  const { Icon, tile, icon } = FLOW_ICON[order.flow]

  return (
    <Link
      href={`/orders/${order.id}`}
      data-testid="order-row"
      className={`flex w-full items-center gap-[13px] rounded-lp-card border border-lp-line bg-lp-surface p-[15px] ${isTerminal(order.status) && order.status !== 'DISPUTED' ? 'opacity-[.72]' : ''}`}
    >
      <span
        data-testid={`order-icon-${order.flow}`}
        className={`flex h-[42px] w-[42px] flex-none items-center justify-center rounded-[13px] ${tile}`}
      >
        <Icon size={20} strokeWidth={2} className={icon} aria-hidden="true" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold text-lp-ink">{FLOW_TITLE[order.flow]}</div>
        <div className="mt-0.5 font-geist-mono text-xs text-lp-muted">
          {formatUSDC(BigInt(order.usdc_amount))} USDC · {timeAgo(order.created_at)}
        </div>
      </div>
      <StatusPill tone={tone}>{label}</StatusPill>
    </Link>
  )
}

function OrderList() {
  const { token } = useAuth()
  const { data: orders, isLoading } = useQuery({
    queryKey: ['orders'],
    queryFn: () => getOrders(client),
    enabled: !!token,
  })

  if (isLoading) {
    return <SkeletonList rows={4} />
  }

  if (!orders || orders.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-lp-line-2">
          <ClipboardList size={24} strokeWidth={1.8} className="text-lp-muted" aria-hidden="true" />
        </span>
        <p className="text-sm text-lp-muted">No orders yet.</p>
        <Link
          href="/buy"
          className="inline-block rounded-lp-pill bg-lp-accent px-4 py-2 font-geist text-sm font-semibold text-white shadow-lp-cta"
        >
          Start your first trade
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2.5">
      {orders.map((o) => (
        <OrderRow key={o.id} order={o} />
      ))}
    </div>
  )
}

export default function OrdersPage() {
  return (
    <div className={`flex min-h-screen flex-col bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader title="Orders" />
      <main className="flex-1 px-[18px] pt-1 animate-lp-rise">
        <ConnectGate>
          <OrderList />
        </ConnectGate>
      </main>
    </div>
  )
}
