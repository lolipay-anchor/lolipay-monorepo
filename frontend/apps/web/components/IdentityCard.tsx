'use client'

import * as React from 'react'
import { useCustomer, useSubmitCustomer } from '@/hooks/useCustomer'
import { splitProviderLink, type KycFieldDescriptor } from '@/lib/kyc'

function AnchorSentence({ message }: { message: string }) {
  const [before, url, after] = splitProviderLink(message)
  if (!url) return <>{message}</>
  return (
    <>
      {before}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="break-all font-medium text-lp-accent underline"
      >
        {url}
      </a>
      {after}
    </>
  )
}

function IdentityForm({ fields }: { fields: Record<string, KycFieldDescriptor> }) {
  const submit = useSubmitCustomer()
  const [values, setValues] = React.useState<Record<string, string>>({})

  return (
    <form
      data-testid="identity-form"
      onSubmit={(e) => {
        e.preventDefault()
        submit.mutate(values)
      }}
      className="mt-3.5 space-y-2.5"
    >
      <div id="identity-form-fields" className="space-y-2.5">
        {Object.keys(fields).map((name) => (
          <div key={name}>
            <label
              htmlFor={`identity-${name}`}
              className="block text-[11px] leading-[1.35] text-lp-ink-soft"
            >
              {fields[name].description}
            </label>
            <input
              id={`identity-${name}`}
              name={name}
              required
              type={name === 'email_address' ? 'email' : 'text'}
              value={values[name] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
              className="mt-1 w-full rounded-[10px] border border-lp-line bg-lp-surface px-3 py-2.5 text-sm text-lp-ink outline-none"
            />
          </div>
        ))}
      </div>

      {submit.isError && (
        <p role="alert" data-testid="identity-refusal" className="text-xs text-lp-danger">
          {(submit.error as Error).message}
        </p>
      )}

      <button
        type="submit"
        disabled={submit.isPending}
        className="w-full rounded-lp-cta bg-lp-ink py-3 font-geist text-sm font-semibold text-lp-paper transition disabled:cursor-not-allowed disabled:opacity-50"
      >
        {submit.isPending ? 'Starting…' : 'Start verification'}
      </button>
    </form>
  )
}

export function IdentityCard() {
  const { data } = useCustomer()
  if (!data) return null

  return (
    <div
      className="rounded-lp-card border border-lp-line bg-lp-surface p-4"
      data-testid="identity-card"
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[.09em] text-lp-muted">
          Identity verification
        </span>
        {data.status === 'ACCEPTED' && (
          <span className="rounded-lp-pill bg-lp-accent-soft px-2.5 py-1 text-xs font-bold text-lp-accent-ink">
            Verified
          </span>
        )}
      </div>

      {data.message && (
        <p className="mt-2.5 text-xs leading-[1.45] text-lp-ink-soft">
          <AnchorSentence message={data.message} />
        </p>
      )}

      {data.status === 'NEEDS_INFO' && data.fields && <IdentityForm fields={data.fields} />}
    </div>
  )
}
