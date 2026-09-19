'use client'

import * as React from 'react'
import { BottomSheet, Button } from '@lolipay/ui'
import { TIERS, limitsLine, type DailyLimits } from '@/lib/daily-limit'

const TIER_LABELS: Record<(typeof TIERS)[number], string> = {
  BRONZE: 'Bronze',
  SILVER: 'Silver',
  TRUSTED: 'Trusted',
  GOLD: 'Gold',
}

const DAILY_LIMIT_ERROR =
  'Every tier needs a whole number of 1 or more. You cannot save until all four have one.'

const TIER_RULE =
  'Tier comes from completed trades — 5 for Silver, 20 for Trusted, 50 for Gold — and each lost dispute drops a person one tier.'

export function validateDailyLimits(limits: DailyLimits): string | null {
  const bad = TIERS.some((tier) => !Number.isSafeInteger(limits[tier]) || limits[tier] < 1)
  return bad ? DAILY_LIMIT_ERROR : null
}

function invertedPairIndex(limits: DailyLimits): number {
  return TIERS.findIndex(
    (tier, i) => i < TIERS.length - 1 && limits[tier] >= limits[TIERS[i + 1]],
  )
}

function ladderWarning(limits: DailyLimits): string | null {
  const at = invertedPairIndex(limits)
  if (at < 0) return null
  const lower = TIER_LABELS[TIERS[at]]
  const upper = TIER_LABELS[TIERS[at + 1]]
  return `${lower} is at or above ${upper}. A depositor on ${lower} would be allowed at least as much per day as one on ${upper}, which is the higher tier. Save anyway only if that is what you intend.`
}

function defaultsNote(tiersOnDefault: readonly (typeof TIERS)[number][]): string | null {
  if (tiersOnDefault.length === 0) return null
  const tail =
    'Saving writes all four as stored values, and a later change to the built-in defaults will not reach them.'
  if (tiersOnDefault.length === TIERS.length) {
    return `No daily limit has been stored, so these built-in defaults are what is in force right now. ${tail}`
  }
  const names = tiersOnDefault.map((tier) => TIER_LABELS[tier]).join(', ')
  return `No limit is stored for ${names}, so their built-in defaults are what is in force right now. ${tail}`
}

export function DailyLimitSection({
  limits,
  onChange,
  disabled,
  tiersOnDefault,
  maxOrderCeiling,
}: {
  limits: DailyLimits
  onChange: (next: DailyLimits) => void
  disabled: boolean
  tiersOnDefault: readonly (typeof TIERS)[number][]
  maxOrderCeiling: string
}) {
  const error = validateDailyLimits(limits)
  const ladder = ladderWarning(limits)
  const defaults = defaultsNote(tiersOnDefault)

  return (
    <section className="bg-lp-surface border border-lp-line rounded-lp-card p-[18px] space-y-4">
      <h2 className="font-geist-mono text-[11px] font-semibold uppercase tracking-[.1em] text-lp-muted">
        Daily limit per person
      </h2>

      <p className="text-[11.5px] text-lp-muted">
        The most one person may put into orders in any 24 hours, counted across every wallet they
        have linked to their account. Linking is something the person does deliberately — a wallet
        they never link is a separate account with its own allowance. It is a rolling 24 hours, not
        a daily reset — room comes back as each order passes its 24th hour.
      </p>

      {defaults && (
        <p className="text-[11.5px] text-lp-muted" data-testid="daily-limit-defaults-note">
          {defaults}
        </p>
      )}

      {TIERS.map((tier) => (
        <label className="block" key={tier}>
          <span className="text-xs text-lp-muted font-semibold">{TIER_LABELS[tier]}</span>
          <input
            type="number"
            min={1}
            max={Number.MAX_SAFE_INTEGER}
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

      <p className="text-[11.5px] text-lp-muted" data-testid="daily-limit-tier-rule">
        {TIER_RULE}
      </p>

      {error && (
        <p className="text-xs text-lp-danger" role="alert" data-testid="daily-limit-error">
          {error}
        </p>
      )}

      {ladder && (
        <p
          className="text-xs text-lp-ink-soft"
          role="status"
          data-testid="daily-limit-ladder-warning"
        >
          {ladder}
        </p>
      )}

      <p className="text-[11.5px] text-lp-muted">
        All four are saved together. Changing one and saving sends all four, because the server
        replaces the whole set — a tier left out would silently go back to its built-in default.
      </p>

      <p className="text-[11.5px] text-lp-muted" data-testid="daily-limit-other-ceilings">
        This is not the only ceiling — but it is usually the tightest. A single order is also capped
        by <strong>Max order</strong> on this page ({maxOrderCeiling}), and a provider can never
        hold more live orders at once than their own stake covers. Any tier set below the Max order
        figure is the ceiling a person actually meets first.
      </p>
    </section>
  )
}

export function DailyLimitConfirm({
  open,
  from,
  to,
  nothingStored,
  canConfirm,
  onCancel,
  onConfirm,
}: {
  open: boolean
  from: DailyLimits
  to: DailyLimits
  nothingStored: boolean
  canConfirm: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const heading = nothingStored
    ? 'Set the daily limit for everyone?'
    : 'Change the daily limit for everyone?'
  const fromLine = nothingStored
    ? `From the built-in defaults — ${limitsLine(from)}, which is what is in force now.`
    : `From the stored limits — ${limitsLine(from)}.`
  const action = nothingStored ? 'Set the limit' : 'Change the limit'

  return (
    <BottomSheet open={open} onClose={onCancel} ariaLabelledBy="daily-limit-confirm-title">
      <div className="space-y-3" data-testid="daily-limit-confirm">
        <h3 id="daily-limit-confirm-title" className="text-[15px] font-semibold text-lp-ink">
          {heading}
        </h3>

        <p className="text-[13px] text-lp-ink-soft">{fromLine}</p>
        <p className="text-[13px] text-lp-ink-soft">
          to {limitsLine(to)}, in USDC per 24 hours per person.
        </p>

        <p className="text-[12px] text-lp-muted">
          Saving stores these four numbers for every depositor. They apply to the next quote or
          order anyone requests. Orders already open are not affected, and a quote already issued is
          re-checked when it becomes an order.
        </p>

        <div className="flex gap-2 pt-1">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button disabled={!canConfirm} onClick={onConfirm}>
            {action}
          </Button>
        </div>
      </div>
    </BottomSheet>
  )
}
