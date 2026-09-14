'use client'
import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getLpMe, heartbeat } from '@lolipay/api-client'
import type { LpMe } from '@lolipay/api-client'
import { client } from '@/lib/client'

export const HEARTBEAT_INTERVAL_MS = 30_000
export const OWN_BEAT_GRACE_MS = HEARTBEAT_INTERVAL_MS * 2
const CLOCK_TICK_MS = 10_000

export function useBeatHealth() {
  const qc = useQueryClient()
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS)
    return () => clearInterval(id)
  }, [])
  const failingSince = qc.getQueryData<number | null>(['lpBeatFailingSince']) ?? null
  const failingFor =
    failingSince !== null && now - failingSince >= OWN_BEAT_GRACE_MS ? now - failingSince : null
  return { now, failingFor }
}

export function HeartbeatKeeper() {
  const qc = useQueryClient()
  const { data: me } = useQuery({
    queryKey: ['lpMe'],
    queryFn: () => getLpMe(client),
    staleTime: Infinity,
  })
  const online = me?.online === true

  React.useEffect(() => {
    if (!online) return
    let rowRefreshed = false
    let stopped = false
    const beat = () => {
      heartbeat(client)
        .then(() => {
          if (stopped) return
          qc.setQueryData(['lpLastBeat'], Date.now())
          qc.setQueryData(['lpBeatFailingSince'], null)
          if (!rowRefreshed && qc.getQueryData<LpMe>(['lpMe'])?.matchable === false) {
            rowRefreshed = true
            qc.invalidateQueries({ queryKey: ['lpMe'] })
          }
        })
        .catch(() => {
          if (stopped) return
          qc.setQueryData<number | null>(['lpBeatFailingSince'], (prev) => prev ?? Date.now())
        })
    }
    beat()
    const id = setInterval(beat, HEARTBEAT_INTERVAL_MS)
    return () => {
      stopped = true
      clearInterval(id)
      qc.setQueryData(['lpBeatFailingSince'], null)
    }
  }, [online, qc])

  return null
}
