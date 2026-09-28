const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'https://api.lolipay.app'
const TIMEOUT_MS = 5_000

export interface AnchorFees {
  depositPercent: number | null
  withdrawPercent: number | null
}

export const NO_ANCHOR_FEES: AnchorFees = { depositPercent: null, withdrawPercent: null }

function publishedPercent(info: unknown, direction: 'deposit' | 'withdraw'): number | null {
  const asset = (info as Record<string, Record<string, Record<string, unknown>> | undefined>)?.[direction]?.USDC
  const percent = asset?.fee_percent
  return typeof percent === 'number' && Number.isFinite(percent) ? percent : null
}

export async function fetchAnchorFees(): Promise<AnchorFees> {
  try {
    const res = await fetch(`${API_BASE}/sep24/info`, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (!res.ok) return NO_ANCHOR_FEES
    const info = await res.json()
    return {
      depositPercent: publishedPercent(info, 'deposit'),
      withdrawPercent: publishedPercent(info, 'withdraw'),
    }
  } catch {
    return NO_ANCHOR_FEES
  }
}
