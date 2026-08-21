'use client'

import { useQuery } from '@tanstack/react-query'
import { fetchUsdcBalance } from '@/lib/balance'

export interface UseUsdcBalanceResult {
  balance: string | null | undefined
  isLoading: boolean
  isError: boolean
  error: Error | null
  refetch: () => Promise<any>
}

export function useUsdcBalance(address?: string | null): UseUsdcBalanceResult {
  const { data: balance, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['usdc-balance', address],
    queryFn: () => fetchUsdcBalance(address as string),
    enabled: !!address,
    refetchInterval: 30_000,
  })
  return { balance, isLoading, isError, error, refetch }
}
