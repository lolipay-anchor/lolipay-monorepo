import { describe, it, expect, vi, afterEach } from 'vitest'
import { fetchAnchorFees } from '../lib/anchor-fees'

const LIVE_INFO_PAYLOAD = {
  deposit: { USDC: { enabled: true, min_amount: 5, max_amount: 1000, fee_percent: 1.5 } },
  withdraw: { USDC: { enabled: true, min_amount: 5, max_amount: 1000 } },
  fee: { enabled: false },
  features: { account_creation: false, claimable_balances: false },
}

const respondWith = (body: unknown, ok = true) =>
  vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchAnchorFees', () => {
  it('reads each direction from the path the anchor actually publishes', async () => {
    vi.stubGlobal('fetch', respondWith(LIVE_INFO_PAYLOAD))

    expect(await fetchAnchorFees()).toEqual({ depositPercent: 1.5, withdrawPercent: null })
  })

  it('reports the fee the anchor publishes, whatever it is', async () => {
    vi.stubGlobal('fetch', respondWith({ deposit: { USDC: { fee_percent: 2.75 } }, withdraw: { USDC: { fee_percent: 0.5 } } }))

    expect(await fetchAnchorFees()).toEqual({ depositPercent: 2.75, withdrawPercent: 0.5 })
  })

  it('a zero fee is a published fee, not a missing one', async () => {
    vi.stubGlobal('fetch', respondWith({ deposit: { USDC: { fee_percent: 0 } }, withdraw: { USDC: {} } }))

    expect(await fetchAnchorFees()).toEqual({ depositPercent: 0, withdrawPercent: null })
  })

  it('yields null for both directions when the anchor is unreachable, and never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await expect(fetchAnchorFees()).resolves.toEqual({ depositPercent: null, withdrawPercent: null })
  })

  it('yields null on a non-ok response', async () => {
    vi.stubGlobal('fetch', respondWith(LIVE_INFO_PAYLOAD, false))

    expect(await fetchAnchorFees()).toEqual({ depositPercent: null, withdrawPercent: null })
  })

  it('yields null when the body is not the shape the anchor documents', async () => {
    vi.stubGlobal('fetch', respondWith({ deposit: { USDC: { fee_percent: 'free' } } }))
    expect(await fetchAnchorFees()).toEqual({ depositPercent: null, withdrawPercent: null })

    vi.stubGlobal('fetch', respondWith({}))
    expect(await fetchAnchorFees()).toEqual({ depositPercent: null, withdrawPercent: null })

    vi.stubGlobal('fetch', respondWith(null))
    expect(await fetchAnchorFees()).toEqual({ depositPercent: null, withdrawPercent: null })
  })

  it('yields null rather than a NaN when the fee is not finite', async () => {
    vi.stubGlobal('fetch', respondWith({ deposit: { USDC: { fee_percent: Number.NaN } } }))

    const fees = await fetchAnchorFees()
    expect(fees).toEqual({ depositPercent: null, withdrawPercent: null })
    expect(Number.isNaN(fees.depositPercent)).toBe(false)
  })

  it('yields null when the body is not JSON at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(new SyntaxError('Unexpected token <')) }))

    await expect(fetchAnchorFees()).resolves.toEqual({ depositPercent: null, withdrawPercent: null })
  })
})
