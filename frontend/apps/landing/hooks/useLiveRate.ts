'use client'
import * as React from 'react'
import { ApiClient, getRate } from '@lolipay/api-client'
import { MARKETS } from '../lib/markets'

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'https://api.lolipay.app'
const POLL_MS = 12_000

const client = new ApiClient({ baseUrl: API_BASE, getToken: () => null, setToken: () => {} })

export function useLiveRate(marketCode: string): { rate: number | null; live: boolean } {
  const market = MARKETS.find((m) => m.code === marketCode) ?? MARKETS[0]
  const [state, setState] = React.useState<{ rate: number | null; live: boolean }>({ rate: null, live: false })

  React.useEffect(() => {
    if (!market.enabled) {
      setState({ rate: null, live: false })
      return
    }
    let stop = false
    const load = async () => {
      try {
        const r = await getRate(client, market.code)
        const n = Number(r.rate)
        if (!stop && Number.isFinite(n) && n > 0) setState({ rate: n, live: true })
      } catch {
        if (!stop) setState((s) => ({ rate: s.rate, live: false }))
      }
    }
    load()
    const id = setInterval(load, POLL_MS)
    return () => {
      stop = true
      clearInterval(id)
    }
  }, [market.code, market.enabled])

  return state
}
