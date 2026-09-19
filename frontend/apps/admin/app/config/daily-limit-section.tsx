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

export const MAX_DAILY_LIMIT_USDC = 10_000_000

const USDC_BASE_UNITS = 10_000_000n

const POSITIVE_INT_STRING = /^[1-9]\d*$/

const TIER_RULE =
  'Tier comes from completed trades — 5 for Silver, 20 for Trusted, 50 for Gold — and each lost dispute drops a person one tier.'

export function dailyLimitFloor(minOrderBaseUnits: string): number {
  if (!POSITIVE_INT_STRING.test(minOrderBaseUnits)) return 1
  return Number((BigInt(minOrderBaseUnits) + USDC_BASE_UNITS - 1n) / USDC_BASE_UNITS)
}

function dailyLimitError(floor: number): string {
  return `Every tier needs a whole number of USDC from ${floor} to ${MAX_DAILY_LIMIT_USDC.toLocaleString('en-US')}. The lower end is the Min order on this page, in whole USDC — a tier below it could place no order at all.`
}

export function validateDailyLimits(limits: DailyLimits, floor: number): string | null {
  const bad = TIERS.some(
    (tier) =>
      !Number.isSafeInteger(limits[tier]) ||
      limits[tier] < floor ||
      limits[tier] > MAX_DAILY_LIMIT_USDC,
  )
  return bad ? dailyLimitError(floor) : null
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
  return `${lower} is at or above ${upper}. A person on ${lower} would be allowed at least as much per day as one on ${upper}, which is the higher tier. Save anyway only if that is what you intend.`
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
  floor,
}: {
  limits: DailyLimits
  onChange: (next: DailyLimits) => void
  disabled: boolean
  tiersOnDefault: readonly (typeof TIERS)[number][]
  maxOrderCeiling: string
  floor: number
}) {
  const error = validateDailyLimits(limits, floor)
  const ladder = ladderWarning(limits)
  const defaults = defaultsNote(tiersOnDefault)

  return (
    <section className="bg-lp-surface border border-lp-line rounded-lp-card p-[18px] space-y-4">
      <h2 className="font-geist-mono text-[11px] font-semibold uppercase tracking-[.1em] text-lp-muted">
        Daily limit per person
      </h2>

      <p className="text-[11.5px] text-lp-muted" data-testid="daily-limit-intro">
        The most one person may put into orders in any 24 hours, counted across every wallet they
        have linked to their account. Linking is something the person does deliberately — a wallet
        they never link is a separate account with its own allowance. It is a rolling 24 hours, not
        a daily reset — room comes back as each order passes its 24th hour — and at once if an order
        expires, is cancelled or is refunded.
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
            min={floor}
            max={MAX_DAILY_LIMIT_USDC}
            step={1}
            value={limits[tier]}
            disabled={disabled}
            onChange={(e) => onChange({ ...limits, [tier]: Number(e.target.value) })}
            data-testid={`daily-limit-${tier}`}
            className="mt-1 block w-full border border-lp-line rounded-lp-tile px-3 py-2 text-sm bg-lp-raise text-lp-ink outline-none disabled:opacity-50"
          />
          <span
            className="mt-1 block text-[11px] text-lp-muted"
            data-testid="daily-limit-floor-hint"
          >
            Whole USDC. At least {floor} — the Min order on this page.
          </span>
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

      <p className="text-[11.5px] text-lp-muted" data-testid="daily-limit-all-four">
        All four are saved together. Changing one and saving sends all four, because the server
        replaces the whole set rather than merging into it — and it refuses a patch that leaves a
        tier out.
      </p>

      <p className="text-[11.5px] text-lp-muted" data-testid="daily-limit-other-ceilings">
        This is not the only ceiling. A single order is also capped by <strong>Max order</strong> on
        this page ({maxOrderCeiling}), and a provider can never take on more at once, in USDC, than
        their own stake covers. Any tier set below the Max order figure is the ceiling a person
        actually meets first.
      </p>
    </section>
  )
}

export function DailyLimitConfirm({
  open,
  from,
  to,
  tiersOnDefault,
  canConfirm,
  onCancel,
  onConfirm,
}: {
  open: boolean
  from: DailyLimits
  to: DailyLimits
  tiersOnDefault: readonly (typeof TIERS)[number][]
  canConfirm: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const nothingStored = tiersOnDefault.length === TIERS.length
  const heading = nothingStored
    ? 'Set the daily limit for everyone?'
    : 'Change the daily limit for everyone?'
  const fromLine = nothingStored
    ? `From the built-in defaults — ${limitsLine(from)}, which is what is in force now.`
    : tiersOnDefault.length === 0
      ? `From the stored limits — ${limitsLine(from)}.`
      : `From what is in force now — ${limitsLine(from)}. ${tiersOnDefault
          .map((tier) => TIER_LABELS[tier])
          .join(', ')} came from the built-in defaults, not from storage; the rest are stored.`
  const action = nothingStored ? 'Set the limit' : 'Change the limit'
  const ladder = ladderWarning(to)

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

        {ladder && (
          <p
            className="text-[12px] text-lp-ink-soft"
            role="status"
            data-testid="daily-limit-confirm-ladder"
          >
            {ladder}
          </p>
        )}

        <p className="text-[12px] text-lp-muted">
          Saving stores these four numbers for everyone, in both directions — the cap covers money
          going in and money coming out. They apply to the next quote or order anyone requests.
          Orders already open are not affected, and a quote already issued is re-checked when it
          becomes an order. The change is recorded against your wallet, old values and new.
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
