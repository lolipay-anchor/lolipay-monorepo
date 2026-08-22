export function spreadCoversPriceDeviation(
  spreadBps: number,
  priceDeviationMaxBps: number,
): string | null {
  if (priceDeviationMaxBps < spreadBps) return null;
  return (
    `PRICE_DEVIATION_MAX_BPS (${priceDeviationMaxBps}) must stay strictly below Config.spreadBps ` +
    `(${spreadBps}) — INV-30.1: one accepted price anomaly would otherwise be able to consume the ` +
    `entire spread cushion on an escrow lock that cannot be repriced`
  );
}
