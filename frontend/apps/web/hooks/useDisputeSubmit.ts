'use client'

import { useMutation } from '@tanstack/react-query'
import { postDispute, uploadDisputeEvidence } from '@lolipay/api-client'
import type { DisputeReason } from '@lolipay/api-client'
import { useWallet } from '@lolipay/wallet'
import { client } from '@/lib/client'
import { defaultSubmit, type SubmitFn } from '@/hooks/useSignOrderTx'

export type { SubmitFn }

export interface DisputeInput {
  orderId: string
  reason: DisputeReason
  note: string

  file?: File | null
}

export function useDisputeSubmit(submitFn: SubmitFn = defaultSubmit) {
  const wallet = useWallet()

  const { mutateAsync, isPending, error, reset } = useMutation({
    mutationFn: async ({ orderId, reason, note, file }: DisputeInput) => {
      let evidenceUrl: string | undefined
      if (file) {
        const { evidence_url } = await uploadDisputeEvidence(client, orderId, file)
        evidenceUrl = evidence_url
      }
      const { dispute_tx } = await postDispute(client, orderId, { reason, note, evidenceUrl })
      const signedXdr = await wallet.signTransaction(dispute_tx.xdr, dispute_tx.networkPassphrase)
      return submitFn(signedXdr, dispute_tx.networkPassphrase)
    },
  })

  return {
    submit: mutateAsync,
    isPending,
    error: error as Error | null,
    reset,
  }
}
