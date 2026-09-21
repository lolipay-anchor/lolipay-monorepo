import { baseUnitsToUsdc } from '../money/money';

export function dailyLimitBelowMinOrderMessage(
  belowFloor: Array<{ tier: string; base: bigint }>,
  nextMinOrder: bigint,
): string {
  const many = belowFloor.length > 1;
  const parts = belowFloor.map(({ tier, base }) => {
    const label = tier.charAt(0) + tier.slice(1).toLowerCase();
    return `the ${label} daily limit of ${baseUnitsToUsdc(base)} USDC`;
  });
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `DAILY_LIMIT_BELOW_MIN_ORDER: ${list} ${many ? 'are' : 'is'} below the Min order of ${baseUnitsToUsdc(nextMinOrder)} USDC, so nobody on ${many ? 'those tiers' : 'that tier'} could ever place an order — every amount is either below Min order or over the daily limit. Raise ${many ? 'those limits' : 'that limit'}, or lower Min order.`;
}

export const CONFIG_WRITE_CONFLICT_SENTENCE =
  "the configuration moved between this save's read and its write, so nothing was changed";
