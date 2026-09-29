const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'https://api.lolipay.app'
const TIMEOUT_MS = 5_000

export interface AnchorFees {
  depositPercent: number | null
  withdrawPercent: number | null
  minAmount?: number | null
  maxAmount?: number | null
}

export const NO_ANCHOR_FEES: AnchorFees = { depositPercent: null, withdrawPercent: null, minAmount: null, maxAmount: null }

function publishedPercent(info: unknown, direction: 'deposit' | 'withdraw'): number | null {
  const asset = (info as Record<string, Record<string, Record<string, unknown>> | undefined>)?.[direction]?.USDC
  const percent = asset?.fee_percent
  return typeof percent === 'number' && Number.isFinite(percent) ? percent : null
}

function publishedAmount(info: unknown, field: 'min_amount' | 'max_amount'): number | null {
  const asset = (info as Record<string, Record<string, Record<string, unknown>> | undefined>)?.deposit?.USDC
  const amount = asset?.[field]
  return typeof amount === 'number' && Number.isFinite(amount) ? amount : null
}

export async function fetchAnchorFees(): Promise<AnchorFees> {
  try {
    const res = await fetch(`${API_BASE}/sep24/info`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) {
      console.error(`anchor fees unavailable: ${API_BASE}/sep24/info returned ${res.status}`)
      return NO_ANCHOR_FEES
    }
    const info = await res.json()
    return {
      depositPercent: publishedPercent(info, 'deposit'),
      withdrawPercent: publishedPercent(info, 'withdraw'),
      minAmount: publishedAmount(info, 'min_amount'),
      maxAmount: publishedAmount(info, 'max_amount'),
    }
  } catch (err) {
    console.error(`anchor fees unavailable: ${API_BASE}/sep24/info failed`, err)
    return NO_ANCHOR_FEES
  }
}
