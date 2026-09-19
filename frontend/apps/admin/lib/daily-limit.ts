import type { UserTier } from '@lolipay/api-client'

export const TIERS = ['BRONZE', 'SILVER', 'TRUSTED', 'GOLD'] as const satisfies readonly UserTier[]

export type DailyLimits = Record<UserTier, number>

export const DEFAULT_DAILY_LIMIT_USDC: DailyLimits = {
  BRONZE: 100,
  SILVER: 300,
  TRUSTED: 600,
  GOLD: 2000,
}

export function limitsFromConfig(stored?: Partial<Record<UserTier, number>> | null): DailyLimits {
  return Object.fromEntries(
    TIERS.map((tier) => {
      const value = stored?.[tier]
      const usable = typeof value === 'number' && Number.isFinite(value) && value >= 0
      return [tier, usable ? value : DEFAULT_DAILY_LIMIT_USDC[tier]]
    }),
  ) as DailyLimits
}

export function limitsToPatch(limits: DailyLimits): DailyLimits {
  return Object.fromEntries(TIERS.map((tier) => [tier, limits[tier]])) as DailyLimits
}

export function limitsLine(limits: DailyLimits): string {
  return `Bronze ${limits.BRONZE} · Silver ${limits.SILVER} · Trusted ${limits.TRUSTED} · Gold ${limits.GOLD}`
}
