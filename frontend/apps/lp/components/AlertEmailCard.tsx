'use client'
import * as React from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { LpMe } from '@lolipay/api-client'
import { StatusPill, Button } from '@lolipay/ui'
import { client } from '@/lib/client'

const ALERT_EMAIL_MAX_LENGTH = 254
const TRANSPORT = /→ \d{3}$|failed to fetch|networkerror|load failed/i
const SAVE_FALLBACK = 'Could not save that address. Check it and try again.'

function explainAlertEmailRefusal(message: string): string {
  if (message.trim() === '' || TRANSPORT.test(message)) return SAVE_FALLBACK
  return message
}

export function AlertEmailCard({ me }: { me: LpMe }) {
  const qc = useQueryClient()
  const [email, setEmail] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState(false)

  const mutation = useMutation({
    mutationFn: (alertEmail: string) => client.request('PATCH', '/lp/me', { alertEmail }),
    onSuccess: () => {
      setError(null)
      setSuccess(true)
      setEmail('')
      qc.invalidateQueries({ queryKey: ['lpMe'] })
    },
    onError: (err) => {
      setSuccess(false)
      setError(explainAlertEmailRefusal(err instanceof Error ? err.message : ''))
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setSuccess(false)
    mutation.mutate(email)
  }

  return (
    <section
      className="rounded-lp-tile border border-lp-line bg-lp-surface p-[15px]"
      data-testid="alert-email-card"
    >
      <div className="flex items-center justify-between">
        <h2 className="font-geist-mono text-[11px] uppercase tracking-[.08em] text-lp-muted">
          Order alerts
        </h2>
        <StatusPill tone={me.reachable ? 'green' : 'amber'}>
          {me.reachable ? 'On' : 'Off'}
        </StatusPill>
      </div>

      <p className="mt-2 text-sm text-lp-ink">
        {me.reachable
          ? 'Alerts can reach you. Every update on an order assigned to you is sent to your email address. The address is not shown back here — enter a new one to replace it.'
          : 'No email address on file. Nothing reaches you when an order is assigned, and an order nobody answers expires on its own.'}
      </p>

      <form onSubmit={handleSubmit} className="mt-3 space-y-2">
        <label className="block" htmlFor="alert-email-input">
          <span className="mb-1 block text-xs font-semibold text-lp-muted">Email address</span>
          <input
            id="alert-email-input"
            data-testid="alert-email-input"
            type="email"
            required
            maxLength={ALERT_EMAIL_MAX_LENGTH}
            placeholder="e.g. you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="mt-1 block w-full rounded-lp-tile border border-lp-line bg-lp-raise px-3 py-2 text-sm text-lp-ink outline-none"
          />
          <span className="mt-1 block text-[11px] text-lp-muted">
            Used only to tell you about your own orders. No confirmation is sent, so check it for typos.
          </span>
        </label>

        {error && (
          <p className="text-xs text-lp-danger" role="alert" data-testid="alert-email-error">
            {error}
          </p>
        )}
        {success && (
          <p className="text-xs text-lp-green" data-testid="alert-email-success">
            Saved. Order alerts now go to that address.
          </p>
        )}

        <Button size="sm" type="submit" loading={mutation.isPending} disabled={mutation.isPending}>
          Save
        </Button>
      </form>
    </section>
  )
}
