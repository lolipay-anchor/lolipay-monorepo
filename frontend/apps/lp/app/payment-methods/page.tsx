'use client'

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  getLpMe,
  addPaymentMethod,
  updatePaymentMethod,
  deletePaymentMethod,
} from '@lolipay/api-client'
import type { PaymentMethod, Rail } from '@lolipay/api-client'
import { Card, Button, Segmented, BottomSheet, StatusPill, NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { AppHeader } from '@/components/AppHeader'
import { client } from '@/lib/client'

const RAIL_OPTIONS: Rail[] = ['BANK', 'QRIS', 'EWALLET']

function AddMethodSheet({
  open,
  onClose,
  onSuccess,
}: {
  open: boolean
  onClose: () => void
  onSuccess: () => void
}) {
  const [rail, setRail] = React.useState<Rail>('BANK')
  const [label, setLabel] = React.useState('')
  const [details, setDetails] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await addPaymentMethod(client, { rail, label, details })
      setLabel('')
      setDetails('')
      setRail('BANK')
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add payment method')
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet open={open} onClose={onClose} ariaLabel="Add Payment Method" dismissible={!busy}>
      <h2 className="mb-4 font-geist text-base font-bold text-lp-ink">Add Payment Method</h2>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Segmented
          options={RAIL_OPTIONS}
          value={rail}
          onChange={(v) => setRail(v as Rail)}
        />
        <div>
          <label className="mb-1 block text-xs text-lp-muted" htmlFor="pm-label">
            Label
          </label>
          <input
            id="pm-label"
            type="text"
            required
            maxLength={500}
            placeholder="e.g. BCA Savings"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full rounded-xl border border-lp-line bg-lp-surface p-2.5 text-sm text-lp-ink outline-none"
            data-testid="pm-label"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-lp-muted" htmlFor="pm-details">
            Details
          </label>
          <textarea
            id="pm-details"
            required
            maxLength={500}
            rows={3}
            placeholder="Account number, name, etc."
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            className="w-full resize-none rounded-xl border border-lp-line bg-lp-surface p-2.5 text-sm text-lp-ink outline-none"
            data-testid="pm-details"
          />
        </div>
        {error && (
          <p className="text-xs text-lp-danger" role="alert">
            {error}
          </p>
        )}
        <Button loading={busy} type="submit">
          Add
        </Button>
      </form>
    </BottomSheet>
  )
}

function EditMethodSheet({
  method,
  onClose,
  onSuccess,
}: {
  method: PaymentMethod | null
  onClose: () => void
  onSuccess: () => void
}) {
  const [rail, setRail] = React.useState<Rail>('BANK')
  const [label, setLabel] = React.useState('')
  const [details, setDetails] = React.useState('')
  const [active, setActive] = React.useState(true)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (method) {
      setRail(method.rail)
      setLabel(method.label)
      setDetails(method.details)
      setActive(method.active)
      setError(null)
    }
  }, [method])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!method) return
    setBusy(true)
    setError(null)
    try {
      await updatePaymentMethod(client, method.id, { rail, label, details, active })
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update payment method')
    } finally {
      setBusy(false)
    }
  }

  return (
    <BottomSheet open={!!method} onClose={onClose} ariaLabel="Edit Payment Method" dismissible={!busy}>
      <h2 className="mb-4 font-geist text-base font-bold text-lp-ink">Edit Payment Method</h2>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <Segmented
          options={RAIL_OPTIONS}
          value={rail}
          onChange={(v) => setRail(v as Rail)}
        />
        <div>
          <label className="mb-1 block text-xs text-lp-muted" htmlFor="pm-edit-label">
            Label
          </label>
          <input
            id="pm-edit-label"
            type="text"
            required
            maxLength={500}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full rounded-xl border border-lp-line bg-lp-surface p-2.5 text-sm text-lp-ink outline-none"
            data-testid="pm-edit-label"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-lp-muted" htmlFor="pm-edit-details">
            Details
          </label>
          <textarea
            id="pm-edit-details"
            required
            maxLength={500}
            rows={3}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
            className="w-full resize-none rounded-xl border border-lp-line bg-lp-surface p-2.5 text-sm text-lp-ink outline-none"
            data-testid="pm-edit-details"
          />
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-sm text-lp-ink">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            data-testid="pm-edit-active"
          />
          Active
        </label>
        {error && (
          <p className="text-xs text-lp-danger" role="alert">
            {error}
          </p>
        )}
        <Button loading={busy} type="submit">
          Save
        </Button>
      </form>
    </BottomSheet>
  )
}

export default function PaymentMethodsPage() {
  const qc = useQueryClient()
  const { data: me, isLoading, isError } = useQuery({
    queryKey: ['lpMe'],
    queryFn: () => getLpMe(client),
  })

  const [addOpen, setAddOpen] = React.useState(false)
  const [editMethod, setEditMethod] = React.useState<PaymentMethod | null>(null)
  const [deleteId, setDeleteId] = React.useState<string | null>(null)
  const [deleteBusy, setDeleteBusy] = React.useState(false)

  const methods = me?.paymentMethods ?? []

  const refetch = () => qc.invalidateQueries({ queryKey: ['lpMe'] })

  const handleDelete = async () => {
    if (!deleteId) return
    setDeleteBusy(true)
    try {
      await deletePaymentMethod(client, deleteId)
      setDeleteId(null)
      refetch()
    } catch {
    } finally {
      setDeleteBusy(false)
    }
  }

  return (
    <div className={`flex min-h-screen flex-col bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader title="Payment Methods" />
      <main className="flex-1 space-y-4 px-[18px] pt-1">
        {isLoading && (
          <p className="py-8 text-center text-sm text-lp-muted">Loading…</p>
        )}
        {isError && (
          <p className="py-4 text-center text-sm text-lp-danger">
            Failed to load payment methods
          </p>
        )}

        {!isLoading && !isError && methods.length === 0 && (
          <p className="py-8 text-center text-sm text-lp-muted">
            No payment methods yet.
          </p>
        )}

        {methods.map((pm) => (
          <Card key={pm.id}>
            <div className="flex items-start justify-between">
              <div className="mr-3 min-w-0 flex-1">
                <p className="font-geist text-sm font-semibold text-lp-ink">{pm.label}</p>
                <p className="mt-0.5 font-geist-mono text-xs text-lp-muted">
                  {pm.rail} · {pm.currency}
                </p>
                <p className="mt-1 break-words text-xs text-lp-muted">{pm.details}</p>
              </div>
              <StatusPill tone={pm.active ? 'green' : 'neutral'}>
                {pm.active ? 'Active' : 'Inactive'}
              </StatusPill>
            </div>
            <div className="mt-3 flex gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setEditMethod(pm)}
              >
                Edit
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="text-lp-danger"
                onClick={() => setDeleteId(pm.id)}
              >
                Delete
              </Button>
            </div>
          </Card>
        ))}

        <Button onClick={() => setAddOpen(true)}>+ Add Payment Method</Button>

        <AddMethodSheet
          open={addOpen}
          onClose={() => setAddOpen(false)}
          onSuccess={() => {
            setAddOpen(false)
            refetch()
          }}
        />

        <EditMethodSheet
          method={editMethod}
          onClose={() => setEditMethod(null)}
          onSuccess={() => {
            setEditMethod(null)
            refetch()
          }}
        />

        {}
        <BottomSheet
          open={!!deleteId}
          onClose={() => setDeleteId(null)}
          ariaLabel="Delete this payment method?"
          dismissible={!deleteBusy}
        >
          <p className="mb-4 text-sm font-semibold text-lp-ink">
            Delete this payment method?
          </p>
          <p className="mb-4 text-xs text-lp-muted">This action cannot be undone.</p>
          <div className="flex gap-3">
            <Button variant="ghost" onClick={() => setDeleteId(null)}>
              Cancel
            </Button>
            <Button variant="danger" loading={deleteBusy} onClick={handleDelete}>
              Confirm Delete
            </Button>
          </div>
        </BottomSheet>
      </main>
    </div>
  )
}
