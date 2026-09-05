'use client'

import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { createOrder } from '@lolipay/api-client'
import { client } from '@/lib/client'
import { explainOrderRefusal } from '@/lib/order-refusal'

export function useCreateOrder(onRefused?: (message: string) => void) {
  const router = useRouter()

  const { mutate, isPending } = useMutation({
    mutationFn: (quoteId: string) => createOrder(client, { quoteId }),
    onSuccess: (res) => {
      router.push('/orders/' + res.order.id)
    },
    onError: (e) => onRefused?.(explainOrderRefusal(e.message)),
  })

  return {
    submit: mutate,
    isPending,
  }
}
