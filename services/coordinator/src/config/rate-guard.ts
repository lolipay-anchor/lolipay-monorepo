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

export function platformFeeFitsSpread(platformFeeBps: number, spreadBps: number, priceDeviationMaxBps: number): string | null {
  if (platformFeeBps + priceDeviationMaxBps >= spreadBps) {
    return `platformFeeBps (${platformFeeBps}) plus priceDeviationMaxBps (${priceDeviationMaxBps}) must stay strictly below Config.spreadBps (${spreadBps}): on a withdrawal the provider keeps the spread less the platform fee, the SEP-24 record declares no fee, and one accepted price move of up to the deviation band must still leave the provider something`;
  }
  return null;
}
