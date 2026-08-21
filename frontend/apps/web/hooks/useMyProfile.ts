'use client'

import { useQuery } from '@tanstack/react-query'
import { getMyProfile } from '@lolipay/api-client'
import { client } from '@/lib/client'

export function useMyProfile() {
  return useQuery({
    queryKey: ['my-profile'],
    queryFn: () => getMyProfile(client),
    staleTime: 30_000,
  })
}
