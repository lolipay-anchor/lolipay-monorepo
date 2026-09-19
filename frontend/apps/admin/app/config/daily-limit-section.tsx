'use client'

import * as React from 'react'
import { BottomSheet, Button } from '@lolipay/ui'
import { TIERS, limitsLine, type DailyLimits } from '@/lib/daily-limit'

const TIER_LABELS: Record<(typeof TIERS)[number], string> = {
  BRONZE: 'Bronze — under 5 completed trades',
  SILVER: 'Silver — 5 or more',
  TRUSTED: 'Trusted — 20 or more',
  GOLD: 'Gold — 50 or more',
}

const DAILY_LIMIT_ERROR =
  'Every tier needs a whole number of 1 or more. Saving without one would put that tier back to its built-in default.'

const BRONZE_OVER_SILVER_WARNING =
  'Bronze is at or above Silver. A brand-new depositor would be allowed more than one with 5 completed trades. Save anyway only if that is what you intend.'

export function validateDailyLimits(limits: DailyLimits): string | null {
  const bad = TIERS.some((tier) => !Number.isInteger(limits[tier]) || limits[tier] < 1)
  return bad ? DAILY_LIMIT_ERROR : null
}

export function DailyLimitSection({
  limits,
  onChange,
  disabled,
  noLimitStored,
  maxOrderCeiling,
}: {
  limits: DailyLimits
  onChange: (next: DailyLimits) => void
  disabled: boolean
  noLimitStored: boolean
  maxOrderCeiling: string
}) {
  const error = validateDailyLimits(limits)
  const bronzeOverSilver = limits.BRONZE >= limits.SILVER

  return (
    <section className="bg-lp-surface border border-lp-line rounded-lp-card p-[18px] space-y-4">
      <h2 className="font-geist-mono text-[11px] font-semibold uppercase tracking-[.1em] text-lp-muted">
        Daily limit per person
      </h2>

      <p className="text-[11.5px] text-lp-muted">
        The most one person may move in any 24 hours, counted across every wallet they link. A
        second wallet does not give them a second allowance. It is a rolling 24 hours, not a daily
        reset — room comes back as each order passes its 24th hour.
      </p>

      {noLimitStored && (
        <p className="text-[11.5px] text-lp-muted" data-testid="daily-limit-defaults-note">
          These are the built-in defaults, in force now. Nothing has been saved yet — saving stores
          all four.
        </p>
      )}

      {TIERS.map((tier) => (
        <label className="block" key={tier}>
          <span className="text-xs text-lp-muted font-semibold">{TIER_LABELS[tier]}</span>
          <input
            type="number"
            min={1}
            step={1}
            value={limits[tier]}
            disabled={disabled}
            onChange={(e) => onChange({ ...limits, [tier]: Number(e.target.value) })}
            data-testid={`daily-limit-${tier}`}
            className="mt-1 block w-full border border-lp-line rounded-lp-tile px-3 py-2 text-sm bg-lp-raise text-lp-ink outline-none disabled:opacity-50"
          />
          <span className="mt-1 block text-[11px] text-lp-muted">Whole USDC. Minimum 1.</span>
        </label>
      ))}

      {error && (
        <p className="text-xs text-lp-danger" role="alert" data-testid="daily-limit-error">
          {error}
        </p>
      )}

      {bronzeOverSilver && (
        <p
          className="text-xs text-lp-ink-soft"
          role="status"
          data-testid="daily-limit-ladder-warning"
        >
          {BRONZE_OVER_SILVER_WARNING}
        </p>
      )}

      <p className="text-[11.5px] text-lp-muted">
        All four are saved together. Changing one and saving sends all four, because the server
        replaces the whole set — a tier left out would silently go back to its built-in default.
      </p>

      <p className="text-[11.5px] text-lp-muted" data-testid="daily-limit-other-ceilings">
        This is not the only ceiling. A single order is still capped at <strong>Max order</strong>{' '}
        above ({maxOrderCeiling}), and a provider can never take more than their own stake.
      </p>
    </section>
  )
}

export function DailyLimitConfirm({
  open,
  from,
  to,
  onCancel,
  onConfirm,
}: {
  open: boolean
  from: DailyLimits
  to: DailyLimits
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <BottomSheet open={open} onClose={onCancel} ariaLabelledBy="daily-limit-confirm-title">
      <div className="space-y-3" data-testid="daily-limit-confirm">
        <h3 id="daily-limit-confirm-title" className="text-[15px] font-semibold text-lp-ink">
          Change the daily limit for everyone?
        </h3>

        <p className="text-[13px] text-lp-ink-soft">From {limitsLine(from)}</p>
        <p className="text-[13px] text-lp-ink-soft">
          to {limitsLine(to)}, in USDC per 24 hours per person.
        </p>

        <p className="text-[12px] text-lp-muted">
          This applies to the next order anyone places. Orders already open are not affected. The
          change is recorded against your wallet.
        </p>

        <div className="flex gap-2 pt-1">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button onClick={onConfirm}>Change the limit</Button>
        </div>
      </div>
    </BottomSheet>
  )
}
