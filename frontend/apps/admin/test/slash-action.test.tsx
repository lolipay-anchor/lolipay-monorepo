import * as React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return { ...actual, getSlashTx: vi.fn(), getSlashState: vi.fn() }
})

import * as apiClient from '@lolipay/api-client'
import { SlashAction, providerDefaulted, formatWindow } from '@/app/orders/page'
import type { Order } from '@lolipay/api-client'

const BASE = {
  id: 'o1',
  trade_id: 't1',
  user_address: 'GUSER',
  lp_wallet: 'GLP',
  rail: 'BANK',
  usdc_amount: '1000000000',
  fiat_amount: '1600000',
  fiat_currency: 'IDR',
  rate_snapshot: '16000',
  platform_fee_bps: 30,
  lp_fee_bps: 120,
  pay_deadline: 1,
  confirm_deadline: 2,
  dispute_deadline: 3,
  expires_at: new Date().toISOString(),
  created_at: new Date().toISOString(),
} as unknown as Order

const SETTLED = new Date(Date.now() - 60_000).toISOString()
const DISPUTED_AFTER = new Date(Date.now() - 30_000).toISOString()

function order(flow: string, status: string): Order {
  return {
    ...BASE,
    flow,
    status,
    settled_at: SETTLED,
    dispute_at: DISPUTED_AFTER,
  } as unknown as Order
}

function undisputed(flow: string, status: string): Order {
  return { ...BASE, flow, status, settled_at: SETTLED, dispute_at: null } as unknown as Order
}

describe('providerDefaulted — who the bond can answer for', () => {
  it('is true only where the provider ended up holding the money', () => {
    expect(providerDefaulted(order('TOP_UP', 'REFUNDED'))).toBe(true)
    expect(providerDefaulted(order('WITHDRAW', 'RELEASED'))).toBe(true)
  })

  it('is false where the user did, because a user posts no bond', () => {
    expect(providerDefaulted(order('TOP_UP', 'RELEASED'))).toBe(false)
    expect(providerDefaulted(order('WITHDRAW', 'REFUNDED'))).toBe(false)
  })

  it('is false before settlement, where the escrow is still the remedy', () => {
    for (const s of ['MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID']) {
      expect(providerDefaulted(order('WITHDRAW', s))).toBe(false)
      expect(providerDefaulted(order('TOP_UP', s))).toBe(false)
    }
  })

  it('is false on a healthy settlement that nobody disputed', () => {
    expect(providerDefaulted(undisputed('WITHDRAW', 'RELEASED'))).toBe(false)
    expect(providerDefaulted(undisputed('TOP_UP', 'REFUNDED'))).toBe(false)
  })

  it('is false when the only dispute happened before settlement', () => {
    const preSettlement = {
      ...BASE,
      flow: 'WITHDRAW',
      status: 'RELEASED',
      settled_at: new Date(Date.now() - 10_000).toISOString(),
      dispute_at: new Date(Date.now() - 60_000).toISOString(),
    } as unknown as Order
    expect(providerDefaulted(preSettlement)).toBe(false)
  })

  it('is true while a settled trade is still being judged, which is the case the contract now allows', () => {
    expect(providerDefaulted(order('WITHDRAW', 'DISPUTED'))).toBe(true)
    expect(providerDefaulted(order('TOP_UP', 'DISPUTED'))).toBe(true)
  })
})

describe('SlashAction', () => {
  beforeEach(() => vi.clearAllMocks())

  it('asks for the full trade value by default and sends exactly that', async () => {
    vi.mocked(apiClient.getSlashTx).mockResolvedValue({
      xdr: 'XDR',
      networkPassphrase: 'NP',
    } as any)
    const submitFn = vi.fn(async () => ({}))
    const onSlashed = vi.fn()

    render(
      <TestProviders kit={fakeKit}>
        <SlashAction order={order('WITHDRAW', 'RELEASED')} onSlashed={onSlashed} submitFn={submitFn} />
      </TestProviders>,
    )

    const input = screen.getByTestId('slash-amount') as HTMLInputElement
    expect(input.value).toBe('1000000000')

    fireEvent.click(screen.getByTestId('slash-submit'))
    await waitFor(() => expect(apiClient.getSlashTx).toHaveBeenCalled())
    expect(vi.mocked(apiClient.getSlashTx).mock.calls[0][2]).toBe('1000000000')
    await waitFor(() => expect(onSlashed).toHaveBeenCalled())
  })

  it('sends a partial amount when the operator lowers it', async () => {
    vi.mocked(apiClient.getSlashTx).mockResolvedValue({ xdr: 'X', networkPassphrase: 'NP' } as any)
    render(
      <TestProviders kit={fakeKit}>
        <SlashAction order={order('TOP_UP', 'REFUNDED')} onSlashed={vi.fn()} submitFn={vi.fn(async () => ({}))} />
      </TestProviders>,
    )
    fireEvent.change(screen.getByTestId('slash-amount'), { target: { value: '250000000' } })
    fireEvent.click(screen.getByTestId('slash-submit'))
    await waitFor(() => expect(apiClient.getSlashTx).toHaveBeenCalled())
    expect(vi.mocked(apiClient.getSlashTx).mock.calls[0][2]).toBe('250000000')
  })

  it('refuses to submit an empty or zero amount', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <SlashAction order={order('TOP_UP', 'REFUNDED')} onSlashed={vi.fn()} submitFn={vi.fn()} />
      </TestProviders>,
    )
    const btn = screen.getByTestId('slash-submit') as HTMLButtonElement
    fireEvent.change(screen.getByTestId('slash-amount'), { target: { value: '' } })
    expect(btn.disabled).toBe(true)
    fireEvent.change(screen.getByTestId('slash-amount'), { target: { value: '0' } })
    expect(btn.disabled).toBe(true)
  })

  it('strips anything that is not a digit, so no decimal ever reaches the contract', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <SlashAction order={order('TOP_UP', 'REFUNDED')} onSlashed={vi.fn()} submitFn={vi.fn()} />
      </TestProviders>,
    )
    const input = screen.getByTestId('slash-amount') as HTMLInputElement
    fireEvent.change(input, { target: { value: '12.5e9-' } })
    expect(input.value).toBe('1259')
  })

  it('surfaces the contract refusal to the operator instead of swallowing it', async () => {
    vi.mocked(apiClient.getSlashTx).mockRejectedValue(
      new Error('a verdict is still pending on this trade — resolve the dispute first, then slash'),
    )
    const onSlashed = vi.fn()
    render(
      <TestProviders kit={fakeKit}>
        <SlashAction order={order('WITHDRAW', 'RELEASED')} onSlashed={onSlashed} submitFn={vi.fn()} />
      </TestProviders>,
    )
    fireEvent.click(screen.getByTestId('slash-submit'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('resolve the dispute first')
    expect(onSlashed).not.toHaveBeenCalled()
  })

  it('does not call onSlashed when submission fails', async () => {
    vi.mocked(apiClient.getSlashTx).mockResolvedValue({ xdr: 'X', networkPassphrase: 'NP' } as any)
    const onSlashed = vi.fn()
    render(
      <TestProviders kit={fakeKit}>
        <SlashAction
          order={order('WITHDRAW', 'RELEASED')}
          onSlashed={onSlashed}
          submitFn={vi.fn(async () => { throw new Error('Submission failed (ERROR)') })}
        />
      </TestProviders>,
    )
    fireEvent.click(screen.getByTestId('slash-submit'))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Submission failed')
    expect(onSlashed).not.toHaveBeenCalled()
  })
})

describe('SlashAction — what has already been recovered', () => {
  beforeEach(() => vi.clearAllMocks())

  it('defaults the amount to what is left, not to the full trade value', async () => {
    vi.mocked(apiClient.getSlashState).mockResolvedValue({
      trade_amount: '1000000000',
      recovered: '600000000',
      remaining: '400000000',
      slash_deadline: Math.floor(Date.now() / 1000) + 7200,
      liability_established: true,
    } as any)
    render(
      <TestProviders kit={fakeKit}>
        <SlashAction order={order('WITHDRAW', 'RELEASED')} onSlashed={vi.fn()} submitFn={vi.fn()} />
      </TestProviders>,
    )
    await waitFor(() => {
      expect((screen.getByTestId('slash-amount') as HTMLInputElement).value).toBe('400000000')
    })
  })

  it('tells the operator how much was already taken, so a repeat is visible', async () => {
    vi.mocked(apiClient.getSlashState).mockResolvedValue({
      trade_amount: '1000000000',
      recovered: '600000000',
      remaining: '400000000',
      slash_deadline: Math.floor(Date.now() / 1000) + 7200,
      liability_established: true,
    } as any)
    render(
      <TestProviders kit={fakeKit}>
        <SlashAction order={order('TOP_UP', 'REFUNDED')} onSlashed={vi.fn()} submitFn={vi.fn()} />
      </TestProviders>,
    )
    const note = await screen.findByTestId('slash-state')
    await waitFor(() => expect(note.textContent).toContain('60.00 of 100.00'))
    expect(note.textContent).toContain('40.00 left')
    expect(note.textContent).toContain('recovers twice')
  })

  it('re-reads the running total after a submission so the next click cannot repeat it', async () => {
    vi.mocked(apiClient.getSlashState)
      .mockResolvedValueOnce({ trade_amount: '1000000000', recovered: '0', remaining: '1000000000', slash_deadline: Math.floor(Date.now() / 1000) + 7200, liability_established: true } as any)
      .mockResolvedValueOnce({ trade_amount: '1000000000', recovered: '1000000000', remaining: '0', slash_deadline: Math.floor(Date.now() / 1000) + 7200, liability_established: true } as any)
    vi.mocked(apiClient.getSlashTx).mockResolvedValue({ xdr: 'X', networkPassphrase: 'NP' } as any)

    render(
      <TestProviders kit={fakeKit}>
        <SlashAction
          order={order('WITHDRAW', 'RELEASED')}
          onSlashed={vi.fn()}
          submitFn={vi.fn(async () => ({}))}
        />
      </TestProviders>,
    )
    await waitFor(() =>
      expect((screen.getByTestId('slash-amount') as HTMLInputElement).value).toBe('1000000000'),
    )
    fireEvent.click(screen.getByTestId('slash-submit'))
    await waitFor(() =>
      expect((screen.getByTestId('slash-amount') as HTMLInputElement).value).toBe('0'),
    )
    expect((screen.getByTestId('slash-submit') as HTMLButtonElement).disabled).toBe(true)
  })

  it('falls back to the trade value when the running total cannot be read', async () => {
    vi.mocked(apiClient.getSlashState).mockRejectedValue(new Error('rpc down'))
    render(
      <TestProviders kit={fakeKit}>
        <SlashAction order={order('WITHDRAW', 'RELEASED')} onSlashed={vi.fn()} submitFn={vi.fn()} />
      </TestProviders>,
    )
    const note = await screen.findByTestId('slash-state')
    expect(note.textContent).toContain('Up to 100.00')
  })
})

describe('the operator can see the clock they are racing', () => {
  beforeEach(() => vi.clearAllMocks())

  function withState(over: Record<string, unknown>) {
    vi.mocked(apiClient.getSlashState).mockResolvedValue({
      trade_amount: '1000000000',
      recovered: '0',
      remaining: '1000000000',
      slash_deadline: Math.floor(Date.now() / 1000) + 7200,
      liability_established: true,
      ...over,
    } as any)
    return render(
      <TestProviders kit={fakeKit}>
        <SlashAction order={order('WITHDRAW', 'RELEASED')} onSlashed={vi.fn()} submitFn={vi.fn()} />
      </TestProviders>,
    )
  }

  it('shows how long is left rather than leaving the operator to guess', async () => {
    withState({ slash_deadline: Math.floor(Date.now() / 1000) + 7200 })
    const w = await screen.findByTestId('slash-window')
    await waitFor(() => expect(w.textContent).toMatch(/1h 5[0-9]m left/))
  })

  it('raises the alarm when under an hour remains', async () => {
    withState({ slash_deadline: Math.floor(Date.now() / 1000) + 600 })
    const w = await screen.findByTestId('slash-window')
    await waitFor(() => expect(w.getAttribute('role')).toBe('alert'))
    expect(w.className).toContain('danger')
  })

  it('says plainly when the window has already closed', async () => {
    withState({ slash_deadline: Math.floor(Date.now() / 1000) - 5 })
    const w = await screen.findByTestId('slash-window')
    await waitFor(() => expect(w.textContent).toMatch(/no longer reachable/i))
  })

  it('explains why a slash is refused when no verdict exists yet', async () => {
    withState({ liability_established: false })
    const w = await screen.findByTestId('slash-window')
    await waitFor(() => expect(w.textContent).toMatch(/resolve the dispute/i))
  })
})

describe('formatWindow', () => {
  it('reads as hours and minutes when there is time', () => {
    expect(formatWindow(7200)).toBe('2h 0m')
    expect(formatWindow(5430)).toBe('1h 30m')
  })

  it('drops to minutes and seconds when it gets tight', () => {
    expect(formatWindow(125)).toBe('2m 5s')
  })

  it('counts the last seconds', () => {
    expect(formatWindow(9)).toBe('9s')
  })
})
