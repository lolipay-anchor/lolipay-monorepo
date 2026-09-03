'use client'
import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { getLpMe, heartbeat } from '@lolipay/api-client'
import { client } from '@/lib/client'

const HEARTBEAT_INTERVAL_MS = 30_000

export function HeartbeatKeeper() {
  const { data: me } = useQuery({
    queryKey: ['lpMe'],
    queryFn: () => getLpMe(client),
    staleTime: Infinity,
  })
  const online = me?.online === true

  React.useEffect(() => {
    if (!online) return
    const beat = () => {
      heartbeat(client).catch(() => {})
    }
    beat()
    const id = setInterval(beat, HEARTBEAT_INTERVAL_MS)
    return () => clearInterval(id)
  }, [online])

  return null
}
