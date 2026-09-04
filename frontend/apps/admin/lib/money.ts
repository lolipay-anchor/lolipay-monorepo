export function formatIDR(n: number): string {
  return 'Rp ' + Math.round(n).toLocaleString('en-US')
}

export function formatUSDC(baseUnits: bigint, decimals = 7): string {
  const divisor = 10n ** BigInt(decimals)
  const whole = baseUnits / divisor
  const frac = ((baseUnits % divisor) * 100n) / divisor
  return `${whole}.${frac.toString().padStart(2, '0')}`
}

