export function formatIDR(n: number): string {
  return 'Rp ' + Math.round(n).toLocaleString('id-ID')
}

export function formatUSDC(baseUnits: bigint, decimals = 7): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = baseUnits / divisor
  const frac = ((baseUnits % divisor) * 100n) / divisor
  return `${whole}.${frac.toString().padStart(2, '0')}`
}

export function parseIDRInput(s: string): number {
  const digits = s.replace(/[^0-9]/g, '')
  return digits ? parseInt(digits, 10) : 0
}

export function formatUsdcNumber(n: number): string {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}
