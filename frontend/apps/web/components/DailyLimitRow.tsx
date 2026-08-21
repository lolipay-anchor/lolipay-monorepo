'use client'

import * as React from 'react'
import { formatUsdcAmount, tierLabel } from '@/lib/format'
import { useMyProfile } from '@/hooks/useMyProfile'

export function DailyLimitRow() {
  const { data: profile, isLoading } = useMyProfile()

  if (isLoading || !profile) return null

  return (
    <p
      data-testid="daily-limit-row"
      className="text-center font-geist-mono text-[10.5px] text-lp-faint"
    >
      Daily limit · {formatUsdcAmount(profile.daily_remaining_usdc)} of{' '}
      {formatUsdcAmount(profile.daily_limit_usdc)} USDC left · {tierLabel(profile.tier)} tier
    </p>
  )
}
