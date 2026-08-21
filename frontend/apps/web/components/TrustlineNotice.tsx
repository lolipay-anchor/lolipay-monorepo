'use client'

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, TransactionBuilder } from '@stellar/stellar-sdk'
import { useWallet } from '@lolipay/wallet'
import { checkUsdcTrustline, buildChangeTrustXdr, networkPassphrase } from '@/lib/trustline'
import { USDC_CODE } from '@/lib/usdcAsset'
import { useToast } from '@/components/Toast'

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org'

export function TrustlineNotice() {
  const wallet = useWallet()
  const qc = useQueryClient()
  const toast = useToast()
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
      <div className="rounded-[14px] bg-lp-amber-soft px-[14px] py-[12px]">
        <p className="text-sm font-semibold text-lp-ink">Activate your wallet first</p>
        <p className="text-xs text-lp-amber mt-0.5">
          This Stellar account isn&apos;t activated yet. Add a little XLM to it, then you can enable
          USDC to receive funds.
        </p>
      </div>
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
      toast(`${USDC_CODE} enabled — you can now receive USDC`, 'success')
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to add trustline'
      setErr(msg)
      toast(msg, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-[14px] bg-lp-amber-soft px-[14px] py-[12px]">
      <div>
        <p className="text-sm font-semibold text-lp-ink">Enable USDC to receive it</p>
        <p className="text-xs text-lp-amber mt-0.5">
          Your wallet needs a one-time {USDC_CODE} trustline before it can receive USDC. You only
          sign this once.
        </p>
      </div>
      {err && (
        <p className="text-xs text-lp-danger" role="alert">
          {err}
        </p>
      )}
      <button
        type="button"
        disabled={busy}
        onClick={addTrustline}
        data-testid="add-trustline"
        className="self-start rounded-lp-cta bg-lp-ink px-4 py-3 font-geist text-sm font-semibold text-lp-paper transition disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy ? (
          <span aria-label="loading" className="inline-block animate-spin">
            ◌
          </span>
        ) : (
          'Enable USDC — sign'
        )}
      </button>
    </div>
  )
}
