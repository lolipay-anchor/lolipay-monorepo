'use client'

import { useMutation } from '@tanstack/react-query'
import { rpc, TransactionBuilder } from '@stellar/stellar-sdk'
import type { ApiClient, TxEnvelope } from '@lolipay/api-client'
import { useWallet } from '@lolipay/wallet'
import { client } from '@/lib/client'

export async function defaultSubmit(signedXdr: string, networkPassphrase: string) {
  const server = new rpc.Server(
    process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  )
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase)
  const res = await server.sendTransaction(tx)

  if (res.status !== 'PENDING') throw new Error(`Submission failed (${res.status})`)
  return res
}

export type SubmitFn = (signedXdr: string, networkPassphrase: string) => Promise<unknown>

export function useSignOrderTx(
  getTx: (c: ApiClient, orderId: string) => Promise<TxEnvelope>,
  submitFn: SubmitFn = defaultSubmit,
) {
  const wallet = useWallet()

  const { mutateAsync, isPending, isSuccess, error, reset } = useMutation({
    mutationFn: async (orderId: string) => {
      const { xdr, networkPassphrase } = await getTx(client, orderId)
      const signedXdr = await wallet.signTransaction(xdr, networkPassphrase)
      return submitFn(signedXdr, networkPassphrase)
    },
  })

  return {
    submit: mutateAsync,
    isPending,
    isSuccess,
    error: error as Error | null,
    reset,
  }
}
