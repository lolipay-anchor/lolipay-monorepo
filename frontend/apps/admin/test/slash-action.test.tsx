import * as React from 'react'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return { ...actual, getSlashTx: vi.fn() }
})

import * as apiClient from '@lolipay/api-client'
import { SlashAction, providerDefaulted } from '@/app/orders/page'
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

function order(flow: string, status: string): Order {
  return { ...BASE, flow, status } as unknown as Order
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
    for (const s of ['MATCHED', 'AWAITING_ONCHAIN', 'FUNDED', 'FIAT_PAID', 'DISPUTED']) {
      expect(providerDefaulted(order('WITHDRAW', s))).toBe(false)
      expect(providerDefaulted(order('TOP_UP', s))).toBe(false)
    }
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
