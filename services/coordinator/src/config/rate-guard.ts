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

export function platformFeeFitsSpread(platformFeeBps: number, spreadBps: number): string | null {
  if (platformFeeBps > spreadBps) {
    return `platformFeeBps (${platformFeeBps}) must not exceed Config.spreadBps (${spreadBps}): on a withdrawal the platform fee is paid out of the spread and the SEP-24 record declares no fee, so a fee above the spread would drain the provider on every trade`;
  }
  return null;
}
