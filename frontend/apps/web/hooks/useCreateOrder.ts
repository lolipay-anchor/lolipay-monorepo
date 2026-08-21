'use client'

import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { createOrder } from '@lolipay/api-client'
import { client } from '@/lib/client'

export function useCreateOrder() {
  const router = useRouter()

  const { mutate, isPending, error } = useMutation({
    mutationFn: (quoteId: string) => createOrder(client, { quoteId }),
    onSuccess: (res) => {
      router.push('/orders/' + res.order.id)
    },
  })

  return {
    submit: mutate,
    isPending,

    error: error as Error | null,
  }
}
