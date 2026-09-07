'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWallet } from '@lolipay/wallet'
import { getLpMe, applyLp } from '@lolipay/api-client'
import type { LpMe } from '@lolipay/api-client'
import { Button } from '@lolipay/ui'
import { useAuth } from '@/app/providers'
import { client } from '@/lib/client'
import { NavShell } from '@/app/nav-shell'
import { HeartbeatKeeper } from './HeartbeatKeeper'
import { LoginScreen } from './LoginScreen'
import { TrustlineNotice } from './TrustlineNotice'

function ApplyForm({ onSuccess }: { onSuccess: () => void }) {
  const [contact, setContact] = React.useState('')
  const [liquidityProof, setLiquidityProof] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await applyLp(client, { contact, liquidityProof })
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Application failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-lp-paper px-6">
      <div className="w-full max-w-sm flex flex-col gap-6">
        <div className="text-center">
          <h1 className="font-geist text-3xl font-bold tracking-[-0.02em] text-lp-ink">
            Apply to be an LP
          </h1>
          <p className="text-sm text-lp-muted mt-2">
            Fill in your contact details and proof of liquidity.
          </p>
        </div>

        {}
        <TrustlineNotice />

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label
              className="block text-sm font-semibold text-lp-ink mb-1"
              htmlFor="lp-contact"
            >
              Contact{' '}
              <span className="text-lp-muted font-normal">(required, &le;500 chars)</span>
            </label>
            <input
              id="lp-contact"
              type="text"
              maxLength={500}
              required
              value={contact}
              onChange={(e) => setContact(e.target.value)}
              className="w-full border border-lp-line rounded-xl p-2.5 bg-lp-surface text-lp-ink text-sm outline-none"
              placeholder="Telegram, email, or other contact"
              data-testid="apply-contact"
            />
          </div>

          <div>
            <label
              className="block text-sm font-semibold text-lp-ink mb-1"
              htmlFor="lp-liquidity-proof"
            >
              Liquidity Proof{' '}
              <span className="text-lp-muted font-normal">(required, &le;500 chars)</span>
            </label>
            <textarea
              id="lp-liquidity-proof"
              maxLength={500}
              required
              rows={3}
              value={liquidityProof}
              onChange={(e) => setLiquidityProof(e.target.value)}
              className="w-full border border-lp-line rounded-xl p-2.5 bg-lp-surface text-lp-ink text-sm resize-none outline-none"
              placeholder="Link to on-chain balance, bank statement, etc."
              data-testid="apply-liquidity-proof"
            />
          </div>

          {error && (
            <p className="text-xs text-lp-danger" role="alert">
              {error}
            </p>
          )}

          <Button loading={busy} type="submit">
            Submit Application
          </Button>
        </form>
      </div>
    </div>
  )
}

function PendingScreen({
  me,
  onRefresh,
}: {
  me: LpMe
  onRefresh: () => void
}) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-lp-paper px-6">
      <div className="w-full max-w-xs flex flex-col items-center gap-6">
        <h1 className="font-geist text-3xl font-bold tracking-[-0.02em] text-lp-ink text-center">
          Application under review
        </h1>
        <p className="text-sm text-lp-muted text-center">
          Your application has been submitted and is being reviewed by the admin team.
        </p>

        <ol className="w-full text-sm text-lp-muted space-y-1">
          <li>1. The lolipay team reviews your application.</li>
          <li>2. Once approved, stake at least the minimum USDC on the Stake tab.</li>
          <li>3. Add a payment method on the Rails tab.</li>
          <li>4. Go online on the Dashboard to start receiving orders.</li>
        </ol>

        <div className="w-full bg-lp-surface border border-lp-line rounded-lp-card p-4 text-sm space-y-2">
          <p>
            <span className="font-semibold text-lp-ink">Contact: </span>
            <span className="text-lp-muted break-words">{me.contact}</span>
          </p>
          <p>
            <span className="font-semibold text-lp-ink">Liquidity Proof: </span>
            <span className="text-lp-muted break-words">{me.liquidityProof}</span>
          </p>
        </div>

        <Button variant="ghost" onClick={onRefresh}>
          Refresh
        </Button>
      </div>
    </div>
  )
}

function NoticeScreen({
  me,
  onDisconnect,
}: {
  me: LpMe
  onDisconnect: () => void
}) {
  const notice =
    me.status === 'SUSPENDED'
      ? 'Your provider account is suspended. Orders are not assigned to you while it is.'
      : 'Your provider account was revoked. It cannot be reopened from this app.'

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-lp-paper px-6">
      <div className="w-full max-w-xs flex flex-col items-center gap-6">
        <h1 className="font-geist text-5xl font-bold tracking-[-0.03em] text-lp-ink">lolipay LP</h1>

        <p className="text-sm text-lp-danger text-center font-semibold">{notice}</p>

        <p className="text-xs text-lp-muted text-center">
          Contact support if you believe this is a mistake.
        </p>

        <div className="w-full">
          <Button variant="ghost" onClick={onDisconnect}>
            Disconnect
          </Button>
        </div>
      </div>
    </div>
  )
}

export function AppGate({ children }: { children: React.ReactNode }) {
  const { token, logout } = useAuth()
  const wallet = useWallet()
  const [hasMounted, setHasMounted] = React.useState(false)

  React.useEffect(() => {
    setHasMounted(true)
  }, [])

  const { data: me, isLoading, refetch } = useQuery({
    queryKey: ['lpMe'],
    queryFn: () => getLpMe(client),
    enabled: !!token,
    retry: false,
    refetchInterval: (q) => (q.state.data?.status === 'PENDING' ? 20_000 : false),
    staleTime: 0,
  })

  if (!hasMounted) return null

  if (!token) return <LoginScreen />

  if (isLoading) return null

  const handleDisconnect = () => {
    wallet.disconnect()
    logout()
  }

  if (me === null) {
    return <ApplyForm onSuccess={() => refetch()} />
  }

  if (me === undefined) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-lp-paper px-6 text-center gap-4">
        <p className="text-4xl">⚠️</p>
        <p className="text-sm text-lp-muted max-w-xs">
          Couldn&apos;t load your LP profile. Check your connection and try again.
        </p>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => refetch()}>
            Retry
          </Button>
          <Button onClick={handleDisconnect}>Disconnect</Button>
        </div>
      </div>
    )
  }

  if (me.status === 'PENDING') {
    return <PendingScreen me={me} onRefresh={() => refetch()} />
  }

  if (me.status === 'SUSPENDED' || me.status === 'REVOKED') {
    return <NoticeScreen me={me} onDisconnect={handleDisconnect} />
  }

  return (
    <>
      {children}
      <HeartbeatKeeper />
      <NavShell />
    </>
  )
}
