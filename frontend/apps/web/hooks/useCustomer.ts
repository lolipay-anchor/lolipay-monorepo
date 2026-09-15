'use client'

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { client } from '@/lib/client'
import type { CustomerRecord } from '@/lib/kyc'

export const CUSTOMER_KEY = ['customer']

export function useCustomer() {
  return useQuery({
    queryKey: CUSTOMER_KEY,
    queryFn: () => client.request<CustomerRecord>('GET', '/customer'),
    staleTime: 30_000,
  })
}

export function useSubmitCustomer() {
  const queries = useQueryClient()
  return useMutation({
    mutationFn: (fields: Record<string, string>) =>
      client.request<{ id: string }>('PUT', '/customer', fields),
    onSuccess: () => queries.invalidateQueries({ queryKey: CUSTOMER_KEY }),
  })
}
