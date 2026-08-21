import * as React from 'react'
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders } from './helpers'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }))

const mockGetOrder = vi.hoisted(() => vi.fn())
const mockGetCreateTradeTx = vi.hoisted(() => vi.fn())
const mockGetConfirmReleaseTx = vi.hoisted(() => vi.fn())

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getOrder: mockGetOrder,
    getCreateTradeTx: mockGetCreateTradeTx,
    getConfirmReleaseTx: mockGetConfirmReleaseTx,
  }
})

const { OrderStatus } = await import('@/components/OrderStatus')
const { stepsFor } = await import('@/lib/steps')

const WITHDRAW_ORDER = {
  id: 'ord-w', trade_id: 'tr-w', user_address: 'GDXXX', lp_wallet: 'GDYYY',
  flow: 'WITHDRAW' as const, rail: 'BANK' as const,
  usdc_amount: '200000000', fiat_amount: '3652000', fiat_currency: 'IDR',
  rate_snapshot: '18260', platform_fee_bps: 30, lp_fee_bps: 120,
  status: 'MATCHED' as const,
  pay_deadline: 0, confirm_deadline: 0, dispute_deadline: 0,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  created_at: new Date().toISOString(),
}

describe('OrderStatus — WITHDRAW (Sell) flow', () => {
  beforeEach(() => vi.clearAllMocks())

  it('uses WITHDRAW step labels', () => {
    const steps = stepsFor('FUNDED', 'WITHDRAW')
    expect(steps[1].label).toBe('You lock USDC')
    expect(steps[2].label).toBe('Merchant pays your bank')
  })

  it('MATCHED: shows Lock USDC and signs create_trade', async () => {
    mockGetOrder.mockResolvedValue({ ...WITHDRAW_ORDER, status: 'MATCHED' })
    mockGetCreateTradeTx.mockResolvedValue({ xdr: 'LOCK_XDR', networkPassphrase: 'np' })
    const submit = vi.fn().mockResolvedValue({ status: 'PENDING' })

    render(
      <TestProviders>
        <OrderStatus id="ord-w" submitFn={submit} />
      </TestProviders>,
    )

    await waitFor(() => screen.getByTestId('lock-usdc'))
    fireEvent.click(screen.getByTestId('lock-usdc'))

    await waitFor(() => {
      expect(mockGetCreateTradeTx).toHaveBeenCalledWith(expect.anything(), 'ord-w')
      expect(submit).toHaveBeenCalledWith('SIGNED_XDR', 'np')
    })
  })

  it('FIAT_PAID: holding the release button signs confirm_and_release', async () => {
    mockGetOrder.mockResolvedValue({ ...WITHDRAW_ORDER, status: 'FIAT_PAID' })
    mockGetConfirmReleaseTx.mockResolvedValue({ xdr: 'REL_XDR', networkPassphrase: 'np' })
    const submit = vi.fn().mockResolvedValue({ status: 'PENDING' })

    render(
      <TestProviders>
        <OrderStatus id="ord-w" submitFn={submit} />
      </TestProviders>,
    )

    const wrapper = await screen.findByTestId('confirm-release')

    const btn = within(wrapper).getByRole('button')

    fireEvent.pointerDown(btn)
    await waitFor(
      () => {
        expect(mockGetConfirmReleaseTx).toHaveBeenCalledWith(expect.anything(), 'ord-w')
        expect(submit).toHaveBeenCalledWith('SIGNED_XDR', 'np')
      },
      { timeout: 3000 },
    )
  })

  it('FIAT_PAID: after a failed release attempt, holding again retries the release (regression)', async () => {
    mockGetOrder.mockResolvedValue({ ...WITHDRAW_ORDER, status: 'FIAT_PAID' })
    mockGetConfirmReleaseTx.mockResolvedValue({ xdr: 'REL_XDR', networkPassphrase: 'np' })

    const submit = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            setTimeout(() => reject(new Error('Submission failed (ERROR)')), 20)
          }),
      )
      .mockResolvedValueOnce({ status: 'PENDING' })

    render(
      <TestProviders>
        <OrderStatus id="ord-w" submitFn={submit} />
      </TestProviders>,
    )

    const wrapper = await screen.findByTestId('confirm-release')
    const btn = within(wrapper).getByRole('button')

    fireEvent.pointerDown(btn)
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1), { timeout: 3000 })

    await waitFor(() => expect(btn).not.toBeDisabled(), { timeout: 3000 })

    fireEvent.pointerDown(btn)
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2), { timeout: 3000 })
  })

  it('FIAT_PAID: after a successful release, the control stays disabled (no re-arm) even before the order refetch lands', async () => {
    mockGetOrder.mockResolvedValue({ ...WITHDRAW_ORDER, status: 'FIAT_PAID' })
    mockGetConfirmReleaseTx.mockResolvedValue({ xdr: 'REL_XDR', networkPassphrase: 'np' })

    const submit = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ status: 'PENDING' }), 20)
        }),
    )

    render(
      <TestProviders>
        <OrderStatus id="ord-w" submitFn={submit} />
      </TestProviders>,
    )

    const wrapper = await screen.findByTestId('confirm-release')
    const btn = within(wrapper).getByRole('button')

    fireEvent.pointerDown(btn)
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1), { timeout: 3000 })

    await waitFor(() => expect(btn).toBeDisabled(), { timeout: 3000 })

    fireEvent.pointerDown(btn)

    await new Promise((r) => setTimeout(r, 1100))
    expect(submit).toHaveBeenCalledTimes(1)
  })
})
