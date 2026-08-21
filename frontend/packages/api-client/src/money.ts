export function usdcToBaseUnits(input: string, decimals = 7): string {
  const trimmed = input.trim()
  if (!/^\d+(\.\d+)?$/.test(trimmed)) throw new Error('Enter a valid USDC amount')
  const [whole, frac = ''] = trimmed.split('.')
  if (frac.length > decimals) throw new Error(`Max ${decimals} decimal places`)
  const scaledFrac = (frac + '0'.repeat(decimals)).slice(0, decimals)
  const base = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(scaledFrac)
  if (base <= 0n) throw new Error('Amount must be greater than 0')
  return base.toString()
}
