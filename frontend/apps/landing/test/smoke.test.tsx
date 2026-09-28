import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const mod = await importOriginal<any>()
  return { ...mod, getRate: vi.fn().mockResolvedValue({ asset: 'USDC', fiat: 'IDR', rate: '16000', ts: '2026-07-07T00:00:00Z' }) }
})

import Home from '../app/page'

const LIVE_INFO_PAYLOAD = {
  deposit: { USDC: { enabled: true, min_amount: 5, max_amount: 1000, fee_percent: 1.5 } },
  withdraw: { USDC: { enabled: true, min_amount: 5, max_amount: 1000 } },
  fee: { enabled: false },
  features: { account_creation: false, claimable_balances: false },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('landing smoke', () => {
  it('renders the hero and the buy/sell widget even when the anchor is unreachable', async () => {
    render(await Home())
    expect(screen.getByRole('heading', { name: /spend crypto/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Buy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sell' })).toBeInTheDocument()
    expect(screen.getByText(/connect wallet to continue/i)).toBeInTheDocument()
  })

  it('carries the fee the anchor publishes all the way from /sep24/info onto the page', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve(LIVE_INFO_PAYLOAD) })
    vi.stubGlobal('fetch', fetchMock)

    render(await Home())
    await waitFor(() => expect(screen.getByText(/live rate/i)).toBeInTheDocument())

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/sep24/info')

    const gross = 500000 / 16000
    const publishedPercent = LIVE_INFO_PAYLOAD.deposit.USDC.fee_percent
    expect(screen.getByText('Network + LP fee').nextSibling?.textContent).toBe(
      `${(gross * (publishedPercent / 100)).toFixed(2)} USDC`,
    )
    expect(screen.getByText('You receive').nextSibling?.textContent).toContain(
      (gross * (1 - publishedPercent / 100)).toFixed(2),
    )
  })

  it('shows no fee-bearing figure on the page when the anchor is unreachable at prerender', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    render(await Home())
    await waitFor(() => expect(screen.getByText(/live rate/i)).toBeInTheDocument())

    expect(screen.getByText('Network + LP fee').nextSibling?.textContent).toBe('—')
    expect(screen.getByText('You receive').nextSibling?.textContent).toContain('—')
    expect(screen.queryByText('30.78')).not.toBeInTheDocument()
    expect(screen.getByText('Rate').nextSibling?.textContent).toBe('1 USDC = Rp 16.000')
  })
})
