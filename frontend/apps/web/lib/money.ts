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
  return IDR_INPUT_RE.test(s.trim())
}

export function parseIDRInput(s: string): number {
  if (!idrInputAccepted(s)) return 0
  return parseInt(s.replace(/[^0-9]/g, ''), 10)
}

export { usdcToBaseUnits } from '@lolipay/api-client'
