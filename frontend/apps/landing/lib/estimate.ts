export function estimateBuy(localAmount: number, rate: number, feePercent: number) {
  const gross = rate > 0 ? localAmount / rate : 0
  const fee = feePercent / 100
  return { usdcNet: gross * (1 - fee), feeUsdc: gross * fee }
}

export function estimateSell(usdc: number, rate: number, feePercent: number) {
  const fee = feePercent / 100
  return { localNet: usdc * (1 - fee) * rate, feeLocal: usdc * fee * rate }
}
