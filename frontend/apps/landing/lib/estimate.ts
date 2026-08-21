const FEE = 0.003

export function estimateBuy(localAmount: number, rate: number) {
  const gross = rate > 0 ? localAmount / rate : 0
  return { usdcNet: gross * (1 - FEE), feeUsdc: gross * FEE }
}

export function estimateSell(usdc: number, rate: number) {
  return { localNet: usdc * (1 - FEE) * rate, feeLocal: usdc * FEE * rate }
}
