'use client'

import * as React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getAdminConfig, patchAdminConfig, ApiError } from '@lolipay/api-client'
import type { AdminConfig } from '@lolipay/api-client'
import { Button, NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { AppHeader } from '@/components/AppHeader'
import { client } from '@/lib/client'

const STELLAR_ADDR_RE = /^G[A-Z2-7]{55}$/
const POSITIVE_INT_STRING_RE = /^[1-9]\d*$/

const CONTRACT_MIN_PAY_WINDOW_SECS = 600
const MIN_USABLE_PAY_WINDOW_SECS = CONTRACT_MIN_PAY_WINDOW_SECS * 2

function validatePlatformWallet(v: string): string | null {
  if (!STELLAR_ADDR_RE.test(v)) return 'Must be a valid Stellar address (G…, 56 chars)'
  return null
}

function validateBps(v: number, name: string): string | null {
  if (!Number.isInteger(v) || v < 0 || v > 9999) return `${name} must be an integer 0–9999`
  return null
}

function validatePositiveInt(v: number, name: string): string | null {
  if (!Number.isInteger(v) || v < 1) return `${name} must be a positive integer`
  return null
}

function validatePayWindow(v: number): string | null {
  if (!Number.isInteger(v) || v < MIN_USABLE_PAY_WINDOW_SECS) {
    return `payWindowSecs must be at least ${MIN_USABLE_PAY_WINDOW_SECS} seconds`
  }
  return null
}

function validateOrderBoundString(v: string, name: string): string | null {
  if (!POSITIVE_INT_STRING_RE.test(v)) return `${name} must be a positive integer (base units)`
  return null
}

type EditableFields = {
  spreadBps: number
  platformFeeBps: number
  lpFeeBps: number
  platformWallet: string
  paused: boolean
  minOrder: string
  maxOrder: string
  payWindowSecs: number
  confirmWindowSecs: number
  disputeWindowSecs: number
  requireProof: boolean
  autoRefund: boolean
  postSettleDisputeWindowSecs: number
}

function configToForm(cfg: AdminConfig): EditableFields {
  return {
    spreadBps: cfg.spreadBps,
    platformFeeBps: cfg.platformFeeBps,
    lpFeeBps: cfg.lpFeeBps,
    platformWallet: cfg.platformWallet,
    paused: cfg.paused,
    minOrder: cfg.minOrder,
    maxOrder: cfg.maxOrder,
    payWindowSecs: cfg.payWindowSecs,
    confirmWindowSecs: cfg.confirmWindowSecs,
    disputeWindowSecs: cfg.disputeWindowSecs,
    requireProof: cfg.requireProof,
    autoRefund: cfg.autoRefund,
    postSettleDisputeWindowSecs: cfg.postSettleDisputeWindowSecs,
  }
}

function computePatch(
  original: EditableFields,
  current: EditableFields,
): Partial<EditableFields> {
  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(current) as (keyof EditableFields)[]) {
    if (current[key] !== original[key]) patch[key] = current[key]
  }
  return patch as Partial<EditableFields>
}

interface NumberFieldProps {
  label: string
  value: number
  onChange: (v: number) => void
  disabled?: boolean
  min?: number
  max?: number
  hint?: string
}

function NumberField({ label, value, onChange, disabled, min = 0, max, hint }: NumberFieldProps) {
  return (
    <label className="block">
      <span className="text-xs text-lp-muted font-semibold">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="mt-1 block w-full border border-lp-line rounded-lp-tile px-3 py-2 text-sm bg-lp-raise text-lp-ink outline-none disabled:opacity-50"
      />
      {hint && <span className="mt-1 block text-[11px] text-lp-muted">{hint}</span>}
    </label>
  )
}

interface TextFieldProps {
  label: string
  value: string
  onChange: (v: string) => void
  disabled?: boolean
  mono?: boolean
}

function TextField({ label, value, onChange, disabled, mono }: TextFieldProps) {
  return (
    <label className="block">
      <span className="text-xs text-lp-muted font-semibold">{label}</span>
      <input
        type="text"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 block w-full border border-lp-line rounded-lp-tile px-3 py-2 text-sm bg-lp-raise text-lp-ink outline-none disabled:opacity-50 ${mono ? 'font-geist-mono' : ''}`}
      />
    </label>
  )
}

interface ToggleFieldProps {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  hint?: string
  testId?: string
}

function ToggleField({ label, checked, onChange, disabled, hint, testId }: ToggleFieldProps) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="text-[13.5px] font-semibold text-lp-ink">{label}</p>
        {hint && <p className="text-[11.5px] text-lp-muted mt-0.5">{hint}</p>}
      </div>
      <label className="relative inline-flex flex-none cursor-pointer items-center">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
          data-testid={testId}
        />
        <span
          aria-hidden="true"
          className="h-[26px] w-11 rounded-full bg-lp-line-2 transition-colors peer-checked:bg-lp-accent peer-disabled:opacity-50"
        />
        <span
          aria-hidden="true"
          className="absolute left-[3px] top-1/2 h-5 w-5 -translate-y-1/2 rounded-full bg-white shadow transition-[left] peer-checked:left-[19px]"
        />
      </label>
    </div>
  )
}

function ConfigForm({ initial }: { initial: AdminConfig }) {
  const queryClient = useQueryClient()
  const [form, setForm] = React.useState<EditableFields>(() => configToForm(initial))
  const [serverError, setServerError] = React.useState<string | null>(null)
  const [savedAt, setSavedAt] = React.useState<string | null>(null)

  React.useEffect(() => {
    setForm(configToForm(initial))
  }, [initial.updatedAt]) // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof EditableFields>(key: K, val: EditableFields[K]) => {
    setForm((prev) => ({ ...prev, [key]: val }))
    setSavedAt(null)
    setServerError(null)
  }

  const feeSum = form.platformFeeBps + form.lpFeeBps
  const feeInvariantViolated = feeSum >= 10000

  const walletErr = validatePlatformWallet(form.platformWallet)
  const spreadErr = validateBps(form.spreadBps, 'spreadBps')
  const platFeeErr = validateBps(form.platformFeeBps, 'platformFeeBps')
  const lpFeeErr = validateBps(form.lpFeeBps, 'lpFeeBps')

  const minOrderErr = validateOrderBoundString(form.minOrder, 'minOrder')
  const maxOrderErr = validateOrderBoundString(form.maxOrder, 'maxOrder')
  const payWindowErr = validatePayWindow(form.payWindowSecs)
  const confirmWindowErr = validatePositiveInt(form.confirmWindowSecs, 'confirmWindowSecs')
  const disputeWindowErr = validatePositiveInt(form.disputeWindowSecs, 'disputeWindowSecs')
  const postSettleWindowErr = validatePositiveInt(
    form.postSettleDisputeWindowSecs,
    'postSettleDisputeWindowSecs',
  )

  const hasValidationError =
    feeInvariantViolated ||
    !!walletErr ||
    !!spreadErr ||
    !!platFeeErr ||
    !!lpFeeErr ||
    !!minOrderErr ||
    !!maxOrderErr ||
    !!payWindowErr ||
    !!confirmWindowErr ||
    !!disputeWindowErr ||
    !!postSettleWindowErr

  const original = React.useMemo(() => configToForm(initial), [initial])
  const patch = computePatch(original, form)
  const isDirty = Object.keys(patch).length > 0

  const mutation = useMutation({
    mutationFn: () => patchAdminConfig(client, patch),
    onSuccess: (updated) => {
      setServerError(null)
      setSavedAt(new Date().toISOString())
      queryClient.setQueryData(['adminConfig'], updated)
    },
    onError: (e) => {
      if (e instanceof ApiError) {
        setServerError(`Error ${e.status}: ${e.message}`)
      } else {
        setServerError(e instanceof Error ? e.message : 'Save failed')
      }
    },
  })

  const canSave = isDirty && !hasValidationError && !mutation.isPending

  return (
    <div className="space-y-4">
      {}
      <section className="bg-lp-surface border border-lp-line rounded-lp-card p-[18px] space-y-4">
        <h2 className="font-geist-mono text-[11px] font-semibold uppercase tracking-[.1em] text-lp-muted">
          Fees &amp; rate
        </h2>

        <NumberField
          label="Spread (bps)"
          value={form.spreadBps}
          onChange={(v) => set('spreadBps', v)}
          disabled={mutation.isPending}
          max={9999}
        />
        {spreadErr && <p className="text-xs text-lp-danger">{spreadErr}</p>}

        <NumberField
          label="Platform fee (bps)"
          value={form.platformFeeBps}
          onChange={(v) => set('platformFeeBps', v)}
          disabled={mutation.isPending}
          max={9999}
        />
        {platFeeErr && <p className="text-xs text-lp-danger">{platFeeErr}</p>}

        <NumberField
          label="LP fee (bps)"
          value={form.lpFeeBps}
          onChange={(v) => set('lpFeeBps', v)}
          disabled={mutation.isPending}
          max={9999}
        />
        {lpFeeErr && <p className="text-xs text-lp-danger">{lpFeeErr}</p>}

        {}
        {feeInvariantViolated && (
          <p className="text-xs text-lp-danger font-semibold" role="alert" data-testid="fee-invariant-error">
            Platform fee + LP fee must be &lt; 10000 bps (current sum: {feeSum})
          </p>
        )}
      </section>

      <section className="bg-lp-surface border border-lp-line rounded-lp-card p-[18px] space-y-4">
        <h2 className="font-geist-mono text-[11px] font-semibold uppercase tracking-[.1em] text-lp-muted">
          Platform
        </h2>

        <label className="block">
          <span className="text-xs text-lp-muted font-semibold">Platform wallet</span>
          <input
            type="text"
            value={form.platformWallet}
            disabled={mutation.isPending}
            onChange={(e) => set('platformWallet', e.target.value)}
            className="mt-1 block w-full border border-lp-line rounded-lp-tile px-3 py-2 text-sm font-geist-mono bg-lp-raise text-lp-ink outline-none disabled:opacity-50"
            placeholder="G…"
          />
          {walletErr && <p className="text-xs text-lp-danger mt-1">{walletErr}</p>}
        </label>

        <ToggleField
          label="Paused"
          checked={form.paused}
          onChange={(v) => set('paused', v)}
          disabled={mutation.isPending}
          hint={form.paused ? 'Yes — exchange paused' : 'No — exchange active'}
          testId="paused-toggle"
        />

        <p className="text-xs text-lp-muted" data-testid="rate-override-note">
          Rate override is per-market now — manage via PATCH /admin/markets/:code (admin UI coming
          in a later phase).
        </p>
      </section>

      {}
      <section className="bg-lp-surface border border-lp-line rounded-lp-card p-[18px] space-y-4">
        <h2 className="font-geist-mono text-[11px] font-semibold uppercase tracking-[.1em] text-lp-muted">
          Anti-fraud
        </h2>

        <ToggleField
          label="Require payment proof"
          checked={form.requireProof}
          onChange={(v) => set('requireProof', v)}
          disabled={mutation.isPending}
          hint={form.requireProof ? 'LPs must upload a receipt before marking paid' : 'Proof upload optional'}
          testId="require-proof-toggle"
        />

        <div className="h-px bg-lp-line-2" />

        <ToggleField
          label="Auto-refund stale orders"
          checked={form.autoRefund}
          onChange={(v) => set('autoRefund', v)}
          disabled={mutation.isPending}
          hint={form.autoRefund ? 'Expired orders auto-refund via the server-signed cron' : 'Manual resolution only'}
          testId="auto-refund-toggle"
        />

        <div className="h-px bg-lp-line-2" />

        <NumberField
          label="Post-settlement dispute window (seconds)"
          value={form.postSettleDisputeWindowSecs}
          onChange={(v) => set('postSettleDisputeWindowSecs', v)}
          disabled={mutation.isPending}
          min={1}
          hint="How long after release/refund either party may still open a dispute."
        />
        {postSettleWindowErr && <p className="text-xs text-lp-danger">{postSettleWindowErr}</p>}
      </section>

      {}
      <section className="bg-lp-surface border border-lp-line rounded-lp-card p-[18px] space-y-4">
        <h2 className="font-geist-mono text-[11px] font-semibold uppercase tracking-[.1em] text-lp-muted">
          Windows &amp; bounds
        </h2>

        <TextField
          label="Min order (base units)"
          value={form.minOrder}
          onChange={(v) => set('minOrder', v)}
          disabled={mutation.isPending}
          mono
        />
        {minOrderErr && <p className="text-xs text-lp-danger">{minOrderErr}</p>}

        <TextField
          label="Max order (base units)"
          value={form.maxOrder}
          onChange={(v) => set('maxOrder', v)}
          disabled={mutation.isPending}
          mono
        />
        {maxOrderErr && <p className="text-xs text-lp-danger">{maxOrderErr}</p>}

        <NumberField
          label="Pay window (seconds)"
          value={form.payWindowSecs}
          onChange={(v) => set('payWindowSecs', v)}
          disabled={mutation.isPending}
          min={MIN_USABLE_PAY_WINDOW_SECS}
          hint={`Minimum ${MIN_USABLE_PAY_WINDOW_SECS}s: the escrow contract refuses a funding signature inside the last ${CONTRACT_MIN_PAY_WINDOW_SECS} seconds of the window, so a shorter window leaves nobody time to sign.`}
        />
        {payWindowErr && <p className="text-xs text-lp-danger">{payWindowErr}</p>}

        <NumberField
          label="Confirm window (seconds)"
          value={form.confirmWindowSecs}
          onChange={(v) => set('confirmWindowSecs', v)}
          disabled={mutation.isPending}
          min={1}
        />
        {confirmWindowErr && <p className="text-xs text-lp-danger">{confirmWindowErr}</p>}

        <NumberField
          label="Dispute window (seconds)"
          value={form.disputeWindowSecs}
          onChange={(v) => set('disputeWindowSecs', v)}
          disabled={mutation.isPending}
          min={1}
        />
        {disputeWindowErr && <p className="text-xs text-lp-danger">{disputeWindowErr}</p>}
      </section>

      {}
      <section className="bg-lp-raise border border-lp-line-2 rounded-lp-card p-[18px] space-y-2">
        <h2 className="font-geist-mono text-[11px] font-semibold uppercase tracking-[.1em] text-lp-muted">
          Read-only
        </h2>
        <div>
          <p className="text-xs text-lp-muted font-semibold">Last updated</p>
          <p className="mt-1 text-sm text-lp-ink">{new Date(initial.updatedAt).toLocaleString()}</p>
        </div>
      </section>

      {}
      {serverError && (
        <p className="text-xs text-lp-danger" role="alert" data-testid="server-error">
          {serverError}
        </p>
      )}

      {}
      {savedAt && (
        <p className="text-xs text-lp-green" data-testid="save-success">
          Saved at {new Date(savedAt).toLocaleTimeString()}
        </p>
      )}

      <Button
        disabled={!canSave}
        loading={mutation.isPending}
        onClick={() => mutation.mutate()}
        data-testid="save-config"
      >
        Save changes
      </Button>
    </div>
  )
}

function ConfigEditor() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['adminConfig'],
    queryFn: () => getAdminConfig(client),
  })

  if (isLoading) {
    return <p className="text-lp-muted text-sm text-center py-8">Loading…</p>
  }

  if (error) {
    return (
      <p className="text-lp-danger text-sm text-center py-8">
        Failed to load config. Please try again.
      </p>
    )
  }

  if (!data) return null

  return <ConfigForm initial={data} />
}

export default function ConfigPage() {
  return (
    <div className={`flex flex-col min-h-screen bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader title="Config" />
      <main className="flex-1 px-[18px] pt-1">
        <ConfigEditor />
      </main>
    </div>
  )
}
