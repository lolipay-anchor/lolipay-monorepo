export function formatIDR(n: number): string {
  return 'Rp ' + Math.round(n).toLocaleString('id-ID')
}
export function formatUSDC(baseUnits: bigint, decimals = 7): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = baseUnits / divisor
  const frac = (baseUnits % divisor) * 100n / divisor
  return `${whole}.${frac.toString().padStart(2, '0')}`
}
const IDR_INPUT_RE = /^(Rp\.?\s*)?(\d+|[1-9]\d{0,2}(\.\d{3})+)$/i

export const IDR_INPUT_REFUSAL =
  'Write the amount in plain digits, for example 200000, or with dots as thousands separators, for example 200.000. Commas, fractions and other symbols are refused because they could mean two different amounts.'

export function idrInputAccepted(s: string): boolean {
  const t = s.trim()
  return IDR_INPUT_RE.test(t) && t.replace(/[^0-9]/g, '').length <= 18
}

export function parseIDRInput(s: string): number {
  if (!idrInputAccepted(s)) return 0
  return parseInt(s.replace(/[^0-9]/g, ''), 10)
}

export function usdcBaseUnitsFor(idr: number, ratePerUsdc: number): string {
  if (!(ratePerUsdc > 0) || !Number.isFinite(idr)) return '0'
  const units = Math.round((idr / ratePerUsdc) * 1e7)
  if (!Number.isSafeInteger(units) || units < 0) return '0'
  return String(units)
}

export { usdcToBaseUnits } from '@lolipay/api-client'
