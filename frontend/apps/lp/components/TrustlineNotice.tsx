'use client'

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, TransactionBuilder } from '@stellar/stellar-sdk'
import { Button, Card } from '@lolipay/ui'
import { useWallet } from '@lolipay/wallet'
import { checkUsdcTrustline, buildChangeTrustXdr, networkPassphrase } from '@/lib/trustline'
import { USDC_CODE } from '@/lib/usdcAsset'

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org'

export function TrustlineNotice() {
  const wallet = useWallet()
  const qc = useQueryClient()
  const address = wallet.address
  const [busy, setBusy] = React.useState(false)
  const [err, setErr] = React.useState<string | null>(null)

  const { data: state } = useQuery({
    queryKey: ['trustline', address],
    queryFn: () => checkUsdcTrustline(address as string),
    enabled: !!address,
    staleTime: 30_000,
  })

  if (!address || !state || state === 'ok') return null

  if (state === 'unfunded') {
    return (
      <Card className="border-lp-amber/40 bg-lp-amber-soft">
        <p className="text-sm font-semibold text-lp-ink">Activate your wallet first</p>
        <p className="text-xs text-lp-ink-soft mt-0.5">
          This Stellar account isn&apos;t activated yet. Add a little XLM to it, then you can enable
          USDC to receive funds.
        </p>
      </Card>
    )
  }

  const addTrustline = async () => {
    setErr(null)
    setBusy(true)
    try {
      const xdr = await buildChangeTrustXdr(address)
      const signed = await wallet.signTransaction(xdr, networkPassphrase)
      const server = new rpc.Server(RPC_URL)
      const tx = TransactionBuilder.fromXDR(signed, networkPassphrase)
      const res = await server.sendTransaction(tx)
      if (res.status !== 'PENDING') throw new Error(`Submission failed (${res.status})`)
      await new Promise((r) => setTimeout(r, 4000))
      await qc.invalidateQueries({ queryKey: ['trustline', address] })
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to add trustline')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="border-lp-amber/40 bg-lp-amber-soft space-y-2">
      <div>
        <p className="text-sm font-semibold text-lp-ink">Enable USDC to receive it</p>
        <p className="text-xs text-lp-ink-soft mt-0.5">
          Your wallet needs a one-time {USDC_CODE} trustline before it can receive USDC. You only
          sign this once.
        </p>
      </div>
      {err && (
        <p className="text-xs text-lp-danger" role="alert">
          {err}
        </p>
      )}
      <Button size="sm" loading={busy} onClick={addTrustline} data-testid="add-trustline">
        Enable USDC — sign
      </Button>
    </Card>
  )
}
