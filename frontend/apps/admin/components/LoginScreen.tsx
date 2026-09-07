'use client'

import { SESSION_EXPIRED } from '@lolipay/api-client'
import * as React from 'react'
import { useWallet } from '@lolipay/wallet'
import { Button } from '@lolipay/ui'
import { useAuth } from '@/app/providers'

export function LoginScreen() {
  const wallet = useWallet()
  const auth = useAuth()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [expired] = React.useState(
    () => typeof sessionStorage !== 'undefined' && sessionStorage.getItem('lp_expired') === '1',
  )

  const handleConnect = async () => {
    setBusy(true)
    setError(null)
    try {
      const addr = wallet.address || (await wallet.connect())
      await auth.login(addr)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Connection failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-lp-paper px-6">
      <div className="w-full max-w-xs flex flex-col items-center gap-8">
        {}
        <div className="flex flex-col items-center gap-4 text-center">
          <span className="flex h-16 w-16 items-center justify-center rounded-[20px] bg-lp-ink shadow-lp-brand">
            <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="9" r="6.4" fill="#E6396B" />
              <rect x="10.6" y="13.5" width="2.8" height="8.2" rx="1.4" fill="#E6396B" />
            </svg>
          </span>
          <div className="flex items-center gap-2">
            <h1 className="font-geist text-4xl font-bold tracking-[-0.02em] text-lp-ink">
              lolipay
            </h1>
            <span className="font-geist-mono text-xs font-bold uppercase tracking-[.08em] text-lp-ink bg-lp-line-2 rounded-md px-2 py-1">
              admin
            </span>
          </div>
        </div>

        {}
        <p className="text-sm text-lp-muted text-center leading-relaxed">
          Approve LPs, manage config &amp; orders.
        </p>

        {}
        <div className="w-full space-y-3">
          <Button loading={busy} onClick={handleConnect}>
            Connect Wallet
          </Button>

          {expired && !error && (
            <p className="text-xs text-lp-muted text-center" role="status" data-testid="session-expired">
              {SESSION_EXPIRED}
            </p>
          )}

          {error && (
            <p className="text-xs text-lp-danger text-center" role="alert">
              {error}
            </p>
          )}
        </div>

        {}
        <p className="text-xs text-lp-muted text-center font-geist-mono">
          Admin wallet required. You sign every action in your own wallet.
        </p>
      </div>
    </div>
  )
}
