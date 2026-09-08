'use client'

import * as React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getLps, setLpStatus, registerLp, ApiError } from '@lolipay/api-client'
import type { Lp, LpStatus } from '@lolipay/api-client'
import { Card, StatusPill, Button, StatCard, NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { Plus } from 'lucide-react'
import { AppHeader } from '@/components/AppHeader'
import { client } from '@/lib/client'

function truncateAddress(addr: string): string {
  if (addr.length <= 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function lpStatusTone(s: LpStatus): 'amber' | 'green' | 'neutral' {
  if (s === 'APPROVED') return 'green'
  if (s === 'PENDING') return 'amber'
  return 'neutral'
}

type Action = 'approve' | 'suspend' | 'revoke'

function actionsForStatus(s: LpStatus): Action[] {
  switch (s) {
    case 'PENDING':   return ['approve', 'revoke']
    case 'APPROVED':  return ['suspend', 'revoke']
    case 'SUSPENDED': return ['approve', 'revoke']
    case 'REVOKED':   return []
  }
}

function actionLabel(a: Action): string {
  return a.charAt(0).toUpperCase() + a.slice(1)
}

function actionVariant(a: Action): 'primary' | 'ghost' {
  return a === 'approve' ? 'primary' : 'ghost'
}

type FilterChip = 'ALL' | LpStatus
const FILTERS: FilterChip[] = ['ALL', 'PENDING', 'APPROVED', 'SUSPENDED', 'REVOKED']

interface PendingAction {
  lpId: string
  action: Action
}

interface LpCardProps {
  lp: Lp
  pendingAction: PendingAction | null
  onActionClick: (lpId: string, action: Action) => void
  onCancel: () => void
  onConfirm: (lpId: string, action: Action, note: string) => void
  isPending: boolean
}

function LpCard({ lp, pendingAction, onActionClick, onCancel, onConfirm, isPending }: LpCardProps) {
  const [note, setNote] = React.useState('')
  const isExpanded = pendingAction?.lpId === lp.id
  const actions = actionsForStatus(lp.status)

  React.useEffect(() => {
    if (!isExpanded) setNote('')
  }, [isExpanded])

  return (
    <Card>
      {}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="font-geist-mono text-sm font-semibold text-lp-ink truncate">
            {truncateAddress(lp.stellarAddress)}
          </p>
          <p className="text-xs text-lp-muted mt-0.5">{lp.contact}</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {lp.online && (
            <span
              className="inline-block w-2 h-2 rounded-full bg-lp-green"
              aria-label="online"
              title="Online"
            />
          )}
          <StatusPill tone={lpStatusTone(lp.status)}>{lp.status}</StatusPill>
        </div>
      </div>

      {}
      {lp.liquidityProof && (
        <p className="text-xs text-lp-muted mt-2 break-words">
          <span className="font-semibold text-lp-ink-soft">Proof: </span>
          {lp.liquidityProof}
        </p>
      )}

      {}
      {lp.approvalNote && (
        <p className="text-xs text-lp-muted mt-1 break-words">
          <span className="font-semibold text-lp-ink-soft">Note: </span>
          {lp.approvalNote}
        </p>
      )}

      {}
      <p className="text-xs text-lp-muted mt-1">
        Applied: {new Date(lp.createdAt).toLocaleString()}
      </p>

      {}
      {actions.length > 0 && (
        <div className="flex gap-2 mt-3">
          {actions.map((a) => (
            <Button
              key={a}
              size="sm"
              variant={actionVariant(a)}
              disabled={isPending || (isExpanded && pendingAction?.action !== a)}
              onClick={() => onActionClick(lp.id, a)}
            >
              {actionLabel(a)}
            </Button>
          ))}
        </div>
      )}

      {}
      {isExpanded && pendingAction && (
        <div className="mt-3 space-y-2" data-testid={`action-form-${lp.id}`}>
          <textarea
            className="w-full text-sm border border-lp-line rounded-lp-tile p-2.5 bg-lp-raise text-lp-ink resize-none outline-none"
            placeholder="Optional note (≤1000 chars)"
            maxLength={1000}
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label="Action note"
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="primary"
              loading={isPending}
              onClick={() => onConfirm(lp.id, pendingAction.action, note)}
              data-testid="confirm-action"
            >
              Confirm {actionLabel(pendingAction.action)}
            </Button>
            <Button size="sm" variant="ghost" disabled={isPending} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

const G_ADDRESS = /^G[A-Z2-7]{55}$/

function RegisterLpForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [stellarAddress, setStellarAddress] = React.useState('')
  const [contact, setContact] = React.useState('')
  const [liquidityProof, setLiquidityProof] = React.useState('')
  const [approve, setApprove] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const addrValid = G_ADDRESS.test(stellarAddress.trim())
  const canSubmit = addrValid && contact.trim().length > 0

  const mutation = useMutation({
    mutationFn: () =>
      registerLp(client, {
        stellarAddress: stellarAddress.trim(),
        contact: contact.trim(),
        liquidityProof: liquidityProof.trim() || undefined,
        approve,
      }),
    onSuccess: () => {
      setError(null)
      onDone()
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Registration failed'),
  })

  return (
    <Card className="mb-4 border-lp-accent/30">
      <p className="text-sm font-bold text-lp-ink mb-3">Register a new LP</p>
      <div className="space-y-3">
        <label className="block">
          <span className="text-xs font-semibold text-lp-muted">Wallet address</span>
          <input
            type="text"
            value={stellarAddress}
            onChange={(e) => setStellarAddress(e.target.value)}
            placeholder="G…"
            data-testid="reg-address"
            className="mt-1 block w-full border border-lp-line rounded-lp-tile px-3 py-2 text-sm font-geist-mono bg-lp-raise text-lp-ink outline-none"
          />
          {stellarAddress.length > 0 && !addrValid && (
            <span className="text-xs text-lp-danger">Must be a valid Stellar address (G…, 56 chars)</span>
          )}
        </label>

        <label className="block">
          <span className="text-xs font-semibold text-lp-muted">Contact</span>
          <input
            type="text"
            value={contact}
            maxLength={500}
            onChange={(e) => setContact(e.target.value)}
            placeholder="Telegram, email, or other contact"
            data-testid="reg-contact"
            className="mt-1 block w-full border border-lp-line rounded-lp-tile px-3 py-2 text-sm bg-lp-raise text-lp-ink outline-none"
          />
        </label>

        <label className="block">
          <span className="text-xs font-semibold text-lp-muted">
            Liquidity proof / note <span className="font-normal">(optional)</span>
          </span>
          <textarea
            value={liquidityProof}
            maxLength={500}
            rows={2}
            onChange={(e) => setLiquidityProof(e.target.value)}
            placeholder="Link to on-chain balance, bank statement, etc."
            className="mt-1 block w-full border border-lp-line rounded-lp-tile px-3 py-2 text-sm bg-lp-raise text-lp-ink resize-none outline-none"
          />
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={approve}
            onChange={(e) => setApprove(e.target.checked)}
            className="w-4 h-4 accent-lp-accent"
            data-testid="reg-approve"
          />
          <span className="text-sm text-lp-ink">
            {approve ? 'Approve immediately (can trade now)' : 'Create as PENDING (review later)'}
          </span>
        </label>

        {error && (
          <p className="text-xs text-lp-danger" role="alert">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <Button
            size="sm"
            loading={mutation.isPending}
            disabled={!canSubmit}
            onClick={() => mutation.mutate()}
            data-testid="reg-submit"
          >
            Register LP
          </Button>
          <Button size="sm" variant="ghost" disabled={mutation.isPending} onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </Card>
  )
}

function LpSummaryStrip({ lps }: { lps: Lp[] }) {
  const approved = lps.filter((l) => l.status === 'APPROVED').length
  const pending = lps.filter((l) => l.status === 'PENDING').length
  const online = lps.filter((l) => l.online).length

  return (
    <div className="grid grid-cols-3 gap-2 mb-4">
      <StatCard label="Approved" value={approved} />
      <StatCard label="Pending" value={<span className="text-lp-amber">{pending}</span>} />
      <StatCard label="Online now" value={<span className="text-lp-green">{online}</span>} />
    </div>
  )
}

function LpList() {
  const queryClient = useQueryClient()
  const [filter, setFilter] = React.useState<FilterChip>('ALL')
  const [pendingAction, setPendingAction] = React.useState<PendingAction | null>(null)
  const [mutError, setMutError] = React.useState<string | null>(null)
  const [showRegister, setShowRegister] = React.useState(false)

  const statusParam = filter === 'ALL' ? undefined : (filter as LpStatus)

  const { data: lps, isLoading, error } = useQuery({
    queryKey: ['lps', filter],
    queryFn: () => getLps(client, statusParam),
  })

  const { data: allLps } = useQuery({
    queryKey: ['lps-all'],
    queryFn: () => getLps(client),
  })

  const mutation = useMutation({
    mutationFn: ({ id, action, note }: { id: string; action: Action; note: string }) =>
      setLpStatus(client, id, action, note || undefined),
    onSuccess: () => {
      setPendingAction(null)
      setMutError(null)
      queryClient.invalidateQueries({ queryKey: ['lps'] })
      queryClient.invalidateQueries({ queryKey: ['lps-all'] })
    },
    onError: (e) => {
      setMutError(e instanceof Error ? e.message : 'Action failed')
      if (e instanceof ApiError && e.status === 409) {
        setPendingAction(null)
        queryClient.invalidateQueries({ queryKey: ['lps'] })
        queryClient.invalidateQueries({ queryKey: ['lps-all'] })
      }
    },
  })

  const handleActionClick = (lpId: string, action: Action) => {
    setMutError(null)

    if (pendingAction?.lpId === lpId && pendingAction?.action === action) {
      setPendingAction(null)
    } else {
      setPendingAction({ lpId, action })
    }
  }

  const handleConfirm = (lpId: string, action: Action, note: string) => {
    mutation.mutate({ id: lpId, action, note })
  }

  return (
    <div>
      {}
      {showRegister ? (
        <RegisterLpForm
          onCancel={() => setShowRegister(false)}
          onDone={() => {
            setShowRegister(false)
            queryClient.invalidateQueries({ queryKey: ['lps'] })
            queryClient.invalidateQueries({ queryKey: ['lps-all'] })
          }}
        />
      ) : (
        <div className="mb-4 flex justify-end">
          <Button size="sm" onClick={() => setShowRegister(true)} data-testid="open-register">
            <span className="inline-flex items-center gap-1.5">
              <Plus size={14} strokeWidth={2.3} />
              Register LP
            </span>
          </Button>
        </div>
      )}

      {}
      {allLps && <LpSummaryStrip lps={allLps} />}

      {}
      <div className="flex gap-2 overflow-x-auto pb-1 mb-4">
        {FILTERS.map((f) => (
          <button
            key={f}
            onClick={() => { setFilter(f); setPendingAction(null) }}
            className={`flex-shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lp-pill border transition ${
              filter === f
                ? 'bg-lp-ink text-white border-lp-ink'
                : 'bg-lp-surface text-lp-muted border-lp-line hover:border-lp-accent'
            }`}
          >
            {f === 'ALL' ? 'All' : f}
          </button>
        ))}
      </div>

      {}
      {mutError && (
        <p className="text-xs text-lp-danger mb-3" role="alert">
          {mutError}
        </p>
      )}

      {}
      {isLoading && (
        <p className="text-lp-muted text-sm text-center py-8">Loading…</p>
      )}

      {error && !isLoading && (
        <p className="text-lp-danger text-sm text-center py-8">
          Failed to load LPs. Please try again.
        </p>
      )}

      {!isLoading && !error && lps && lps.length === 0 && (
        <p className="text-lp-muted text-sm text-center py-8">No LPs found.</p>
      )}

      {!isLoading && !error && lps && lps.length > 0 && (
        <ul className="space-y-3">
          {lps.map((lp) => (
            <li key={lp.id}>
              <LpCard
                lp={lp}
                pendingAction={pendingAction}
                onActionClick={handleActionClick}
                onCancel={() => setPendingAction(null)}
                onConfirm={handleConfirm}
                isPending={mutation.isPending}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export default function LPsPage() {
  return (
    <div className={`flex flex-col min-h-screen bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader title="LPs" />
      <main className="flex-1 px-[18px] pt-1">
        <LpList />
      </main>
    </div>
  )
}
