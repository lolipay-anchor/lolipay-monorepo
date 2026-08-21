'use client'

import * as React from 'react'
import { useWallet } from '@lolipay/wallet'
import { useAuth } from '@/app/providers'
import { Button } from '@lolipay/ui'

export function ConnectGate({ children }: { children: React.ReactNode }) {
  const wallet = useWallet()
  const auth = useAuth()
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  if (auth.token) return <>{children}</>

  const handleConnect = async () => {
    setBusy(true)
    setError(null)
    try {
      const addr = wallet.address || (await wallet.connect())
      await auth.login(addr)
    } catch (e) {
      console.error('[login] connect failed:', e)
      setError(e instanceof Error ? e.message : 'Connection failed — please try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-2">
      <Button loading={busy} onClick={handleConnect}>
        Connect Wallet
      </Button>
      {}
      {busy && !error && (
        <p className="text-xs text-muted text-center" role="status">
          Approve the request in your wallet app to continue.
        </p>
      )}
      {error && (
        <p className="text-xs text-red-500 text-center" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
