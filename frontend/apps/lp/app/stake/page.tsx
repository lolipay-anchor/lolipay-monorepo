'use client'

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { rpc, TransactionBuilder } from '@stellar/stellar-sdk'
import {
  getLpEligibility,
  getStakeTx,
  getRequestUnstakeTx,
  getClaimUnstakeTx,
} from '@lolipay/api-client'
import { submissionFailure, useWallet } from '@lolipay/wallet'
import { Card, Button, StatusPill, DarkHeroCard, NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { AppHeader } from '@/components/AppHeader'
import { client } from '@/lib/client'
import { formatUSDC } from '@/lib/money'
import { usdcToBaseUnits } from '@/lib/usdc'
import { stakeIsReady } from '@/components/PrereqCard'

export type SubmitFn = (signedXdr: string, networkPassphrase: string) => Promise<unknown>

export const CONFIRMING_MESSAGE =
  'Submitted. Your stake updates once the network confirms it — this can take a few seconds.'

async function defaultSubmit(signedXdr: string, networkPassphrase: string) {
  const server = new rpc.Server(
    process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org',
  )
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase)
  const res = await server.sendTransaction(tx)

  if (res.status !== 'PENDING') throw new Error(submissionFailure(res))

  const final = await server.pollTransaction(res.hash)
  if (final.status === 'NOT_FOUND') {
    throw new Error(
      'Still confirming on the network. This may already have gone through — refresh before trying again.',
    )
  }
  if (final.status !== 'SUCCESS') {
    throw new Error(submissionFailure({ status: final.status, errorResult: final.resultXdr }))
  }
  return final
}

function timeUntilLabel(unixSeconds: number): string {
  const hoursRemaining = (unixSeconds - Date.now() / 1000) / 3600
  if (hoursRemaining < 24) {
    const hours = Math.max(1, Math.round(hoursRemaining))
    return `${hours} hour${hours === 1 ? '' : 's'}`
  }
  const days = Math.round(hoursRemaining / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

export function StakeForm({ submitFn = defaultSubmit }: { submitFn?: SubmitFn }) {
  const wallet = useWallet()
  const qc = useQueryClient()

  const [amount, setAmount] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [success, setSuccess] = React.useState(false)

  const [unstakeAmount, setUnstakeAmount] = React.useState('')
  const [unstakeBusy, setUnstakeBusy] = React.useState(false)
  const [unstakeConfirming, setUnstakeConfirming] = React.useState(false)
  const [unstakeError, setUnstakeError] = React.useState<string | null>(null)
  const [unstakeSuccess, setUnstakeSuccess] = React.useState(false)
  const [claimBusy, setClaimBusy] = React.useState(false)
  const [claimConfirming, setClaimConfirming] = React.useState(false)
  const [claimError, setClaimError] = React.useState<string | null>(null)

  const {
    data: eligibility,
    isLoading,
    isError,
  } = useQuery({
    queryKey: ['lpEligibility'],
    queryFn: () => getLpEligibility(client),
  })

  const handleStake = async (e: React.FormEvent) => {
    e.preventDefault()
    let baseUnits: string
    try {
      baseUnits = usdcToBaseUnits(amount)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Enter a valid USDC amount')
      return
    }
    setBusy(true)
    setError(null)
    setSuccess(false)
    try {
      const { xdr, networkPassphrase } = await getStakeTx(client, baseUnits)
      const signedXdr = await wallet.signTransaction(xdr, networkPassphrase)
      setConfirming(true)
      await submitFn(signedXdr, networkPassphrase)
      setSuccess(true)
      setAmount('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Stake failed')
    } finally {
      setBusy(false)
      setConfirming(false)
      qc.invalidateQueries({ queryKey: ['lpEligibility'] })
    }
  }

  const handleRequestUnstake = async (e: React.FormEvent) => {
    e.preventDefault()
    let baseUnits: string
    try {
      baseUnits = usdcToBaseUnits(unstakeAmount)
    } catch (err) {
      setUnstakeError(err instanceof Error ? err.message : 'Enter a valid USDC amount')
      return
    }
    setUnstakeBusy(true)
    setUnstakeError(null)
    setUnstakeSuccess(false)
    try {
      const { xdr, networkPassphrase } = await getRequestUnstakeTx(client, baseUnits)
      const signedXdr = await wallet.signTransaction(xdr, networkPassphrase)
      setUnstakeConfirming(true)
      await submitFn(signedXdr, networkPassphrase)
      setUnstakeSuccess(true)
      setUnstakeAmount('')
    } catch (err) {
      setUnstakeError(err instanceof Error ? err.message : 'Unstake request failed')
    } finally {
      setUnstakeBusy(false)
      setUnstakeConfirming(false)
      qc.invalidateQueries({ queryKey: ['lpEligibility'] })
    }
  }

  const handleClaim = async () => {
    setClaimBusy(true)
    setClaimError(null)
    try {
      const { xdr, networkPassphrase } = await getClaimUnstakeTx(client)
      const signedXdr = await wallet.signTransaction(xdr, networkPassphrase)
      setClaimConfirming(true)
      await submitFn(signedXdr, networkPassphrase)
    } catch (err) {
      setClaimError(err instanceof Error ? err.message : 'Claim failed')
    } finally {
      setClaimBusy(false)
      setClaimConfirming(false)
      qc.invalidateQueries({ queryKey: ['lpEligibility'] })
    }
  }

  if (isLoading) {
    return <p className="py-8 text-center text-sm text-lp-muted">Loading eligibility…</p>
  }

  if (isError || !eligibility) {
    return <p className="py-8 text-center text-sm text-lp-danger">Failed to load eligibility</p>
  }

  const staked = formatUSDC(BigInt(eligibility.staked))
  const minStake = formatUSDC(BigInt(eligibility.min_stake))
  const hasStaked = BigInt(eligibility.staked) > 0n
  const hasUnbonding = BigInt(eligibility.unbonding) > 0n
  const claimable =
    hasUnbonding && Date.now() / 1000 >= eligibility.unbond_available_at
  const matchable = stakeIsReady(eligibility) === true

  const stakedNum = Number(eligibility.staked) / 1e7
  const minStakeNum = Number(eligibility.min_stake) / 1e7
  const stakePct = minStakeNum > 0 ? Math.min(100, (stakedNum / minStakeNum) * 100) : 0
  const coverage = minStakeNum > 0 ? stakedNum / minStakeNum : 0

  return (
    <div className="space-y-4">
      {}
      <DarkHeroCard>
        <div className="flex items-center justify-between">
          <span className="font-geist-mono text-[11px] uppercase tracking-[.1em] text-lp-paper/55">
            Your stake
          </span>
          {matchable ? (
            <StatusPill tone="green">Eligible</StatusPill>
          ) : (
            <StatusPill tone="amber">Not eligible</StatusPill>
          )}
        </div>
        <div className="mt-2 font-geist text-[32px] font-bold tracking-[-0.03em]">
          {staked} <span className="text-base font-normal text-lp-paper/60">USDC</span>
        </div>
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-white/15">
          <div
            className="h-full rounded-full bg-lp-green"
            style={{ width: `${stakePct}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-[11.5px] text-lp-paper/60">
          <span>Minimum {minStake} USDC</span>
          <span>{coverage.toFixed(1)}× covered</span>
        </div>
        {!eligibility.eligible && (
          <p className="mt-3 text-xs text-lp-amber-soft">
            You need at least {minStake} USDC staked to take orders.
          </p>
        )}
      </DarkHeroCard>

      {}
      <Card>
        <p className="mb-3 font-geist text-sm font-semibold text-lp-ink">Stake USDC</p>
        <p className="mb-3 text-xs text-lp-muted">
          Your staked USDC is the bond behind your trades. If a dispute raised after a trade has settled is resolved against you, what you owe can be taken from your stake — including USDC that is unbonding but not yet claimed.
        </p>
        <form onSubmit={handleStake} className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-xs text-lp-muted" htmlFor="stake-amount">
              Amount (USDC)
            </label>
            <input
              id="stake-amount"
              type="number"
              min="0.0000001"
              step="any"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="w-full rounded-xl border border-lp-line bg-lp-raise p-2.5 text-sm text-lp-ink outline-none"
              placeholder="0.00"
              data-testid="stake-amount"
            />
          </div>
          {error && (
            <p className="text-xs text-lp-danger" role="alert">
              {error}
            </p>
          )}
          {confirming && (
            <p className="text-xs text-lp-muted" role="status">
              {CONFIRMING_MESSAGE}
            </p>
          )}
          {success && (
            <p className="text-xs text-lp-green" role="status">
              Stake submitted successfully.
            </p>
          )}
          <Button loading={busy} type="submit">
            Stake
          </Button>
        </form>
      </Card>

      {}
      <Card>
        <p className="mb-1 font-geist text-sm font-semibold text-lp-ink">Unstake USDC</p>
        <p className="mb-3 text-xs text-lp-muted">
          The amount leaves your stake the moment you sign — you can claim it to your wallet once the cooldown ends. If what is left is under the {minStake} USDC minimum, you stop taking orders.
        </p>
        <form onSubmit={handleRequestUnstake} className="flex flex-col gap-3">
          <div>
            <label className="mb-1 block text-xs text-lp-muted" htmlFor="unstake-amount">
              Amount (USDC)
            </label>
            <input
              id="unstake-amount"
              type="number"
              min="0.0000001"
              step="any"
              required
              value={unstakeAmount}
              onChange={(e) => setUnstakeAmount(e.target.value)}
              className="w-full rounded-xl border border-lp-line bg-lp-raise p-2.5 text-sm text-lp-ink outline-none disabled:opacity-50"
              placeholder="0.00"
              data-testid="unstake-amount"
              disabled={!hasStaked}
            />
          </div>
          {unstakeError && (
            <p className="text-xs text-lp-danger" role="alert">
              {unstakeError}
            </p>
          )}
          {unstakeConfirming && (
            <p className="text-xs text-lp-muted" role="status">
              {CONFIRMING_MESSAGE}
            </p>
          )}
          {unstakeSuccess && (
            <p className="text-xs text-lp-green" role="status">
              Unstake requested — cooldown started.
            </p>
          )}
          <Button variant="ghost" loading={unstakeBusy} type="submit" disabled={!hasStaked}>
            Request Unstake
          </Button>
        </form>

        {hasUnbonding && (
          <div className="mt-4 border-t border-lp-line pt-3">
            <p className="mb-2 text-xs text-lp-muted">
              {claimable
                ? `${formatUSDC(BigInt(eligibility.unbonding))} USDC is ready to claim. Claiming returns it to your wallet — it does not go back into your stake, and nothing happens until you sign.`
                : `${formatUSDC(BigInt(eligibility.unbonding))} USDC unbonding — claimable ${new Date(eligibility.unbond_available_at * 1000).toLocaleString()}, about ${timeUntilLabel(eligibility.unbond_available_at)} from now. Claiming returns it to your wallet, not to your stake.`}
            </p>
            {claimError && (
              <p className="mb-2 text-xs text-lp-danger" role="alert">
                {claimError}
              </p>
            )}
            {claimConfirming && (
              <p className="mb-2 text-xs text-lp-muted" role="status">
                {CONFIRMING_MESSAGE}
              </p>
            )}
            <Button
              variant="ghost"
              loading={claimBusy}
              disabled={!claimable}
              onClick={handleClaim}
              data-testid="claim-unstake"
            >
              Claim Unstaked USDC
            </Button>
          </div>
        )}
      </Card>
    </div>
  )
}

export default function StakePage() {
  return (
    <div className={`flex min-h-screen flex-col bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader title="Stake" />
      <main className="flex-1 px-[18px] pt-1">
        <StakeForm />
      </main>
    </div>
  )
}
