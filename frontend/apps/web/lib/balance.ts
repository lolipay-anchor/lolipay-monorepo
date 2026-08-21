import { HORIZON_URL, USDC_CODE, USDC_ISSUER } from './usdcAsset'

export async function fetchUsdcBalance(address: string): Promise<string | null> {
  const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(address)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`Horizon account lookup failed (${res.status})`)
  const data = await res.json()
  const entry = (data.balances ?? []).find(
    (b: { asset_code?: string; asset_issuer?: string }) =>
      b.asset_code === USDC_CODE && b.asset_issuer === USDC_ISSUER,
  )
  return entry ? (entry.balance as string) : null
}

export function formatUsdcBalance(balance: string): string {
  const [wholeRaw, fracRaw = ''] = balance.split('.')
  const whole = (wholeRaw || '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const frac = fracRaw.padEnd(2, '0').slice(0, 2)
  return `${whole}.${frac}`
}
