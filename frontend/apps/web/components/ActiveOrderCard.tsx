'use client'

import * as React from 'react'
import Link from 'next/link'
import { useQuery } from '@tanstack/react-query'
import { getOrders } from '@lolipay/api-client'
import type { Order, OrderStatus, Flow } from '@lolipay/api-client'
import { StatusPill, SegmentProgress } from '@lolipay/ui'
import { ChevronRight } from 'lucide-react'
import { useAuth } from '@/app/providers'
import { client } from '@/lib/client'
import { formatUSDC } from '@/lib/money'
import { stepsFor } from '@/lib/steps'
import { timeAgo, flowLabel, pillFor } from '@/lib/format'

const HOME_HIDDEN: OrderStatus[] = ['RELEASED', 'REFUNDED', 'CANCELLED', 'EXPIRED']

function stepsDone(status: OrderStatus, flow: Flow): number {
  return stepsFor(status, flow).filter((s) => s.state !== 'pending').length
}

function OrderCard({ order }: { order: Order }) {
  const { tone, label } = pillFor(order.status, order.flow)
  return (
    <Link
      href={`/orders/${order.id}`}
      className="flex w-full flex-col gap-[13px] rounded-lp-card border border-lp-line bg-lp-surface p-4 text-left"
    >
      <div className="flex items-center justify-between">
        <span className="font-geist-mono text-[11px] uppercase tracking-[.1em] text-lp-muted">
          Active order
        </span>
        <StatusPill tone={tone}>{label}</StatusPill>
      </div>
      <div className="flex items-end justify-between">
        <div>
          <div className="font-geist-mono text-2xl font-bold tracking-[-0.02em]">
            {formatUSDC(BigInt(order.usdc_amount))}{' '}
            <span className="text-sm font-semibold text-lp-muted">USDC</span>
          </div>
          <div className="mt-0.5 text-[13px] text-lp-muted">
            {flowLabel(order.flow)} · {timeAgo(order.created_at)}
          </div>
        </div>
        <span className="flex items-center gap-1 text-[13px] font-semibold text-lp-accent-ink">
          View <ChevronRight size={15} strokeWidth={2.2} aria-hidden="true" />
        </span>
      </div>
      <SegmentProgress total={4} done={stepsDone(order.status, order.flow)} />
    </Link>
  )
}

export function ActiveOrderCard() {
  const { token } = useAuth()

  const { data: orders } = useQuery({
    queryKey: ['orders'],
    queryFn: () => getOrders(client),
    enabled: !!token,
  })

  if (!token) return null

  const active = (orders ?? []).filter((o) => !HOME_HIDDEN.includes(o.status))
  if (active.length === 0) return null

  return (
    <div className="flex flex-col gap-3">
      {active.map((order) => (
        <OrderCard key={order.id} order={order} />
      ))}
    </div>
  )
}
