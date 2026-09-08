'use client'
import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { Eligibility, LpMe } from '@lolipay/api-client'
import { StatusPill } from '@lolipay/ui'

const HEARTBEAT_FRESH_MS = 120_000
const CLOCK_TICK_MS = 10_000

function unbondingIsZero(value: string): boolean {
  try {
    return BigInt(value) === 0n
  } catch {
    return false
  }
}

function Row({
  id,
  ok,
  label,
  children,
}: {
  id: string
  ok: boolean | null
  label: string
  children: React.ReactNode
}) {
  return (
    <li
      className="flex items-center justify-between gap-3"
      data-testid={`prereq-${id}`}
      data-ok={ok === null ? 'unknown' : String(ok)}
    >
      <span className="text-sm text-lp-ink">{label}</span>
      <StatusPill tone={ok === null ? 'neutral' : ok ? 'green' : 'amber'}>{children}</StatusPill>
    </li>
  )
}

export function PrereqCard({ me, eligibility }: { me: LpMe; eligibility: Eligibility | undefined }) {
  const qc = useQueryClient()
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(id)
  }, [])

  const staked = eligibility ? eligibility.eligible && unbondingIsZero(eligibility.unbonding) : null
  const paymentMethod = me.paymentMethods.some((m) => m.active && m.rail === 'BANK')
  const ownBeat = qc.getQueryData<number>(['lpLastBeat']) ?? 0
  const parsedServerBeat = me.lastHeartbeatAt === null ? 0 : Date.parse(me.lastHeartbeatAt)
  const serverBeat = Number.isFinite(parsedServerBeat) ? parsedServerBeat : 0
  const lastBeat = Math.max(ownBeat, serverBeat)
  const age = lastBeat > 0 ? Math.max(0, Math.floor((now - lastBeat) / 1000)) : null
  const heartbeat = me.online && lastBeat > 0 && now - lastBeat < HEARTBEAT_FRESH_MS

  return (
    <section
      className="rounded-lp-tile border border-lp-line bg-lp-surface p-[15px]"
      data-testid="prereq-card"
      aria-label="Ready to receive orders"
    >
      <h2 className="font-geist-mono text-[11px] uppercase tracking-[.08em] text-lp-muted">
        Ready to receive orders
      </h2>
      <ul className="mt-2 space-y-2">
        <Row id="stake" ok={staked} label="Staked at least the minimum, nothing unbonding">
          {staked === null ? '—' : staked ? 'Done' : 'To do'}
        </Row>
        <Row id="payment-method" ok={paymentMethod} label="A bank payment method, active">
          {paymentMethod ? 'Done' : 'To do'}
        </Row>
        <Row id="heartbeat" ok={heartbeat} label="Online, with a recent heartbeat">
          {age === null ? 'not yet' : `last seen ${age} s ago`}
        </Row>
      </ul>
    </section>
  )
}
