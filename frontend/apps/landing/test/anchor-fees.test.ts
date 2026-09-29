import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fetchAnchorFees } from '../lib/anchor-fees'

const LIVE_INFO_PAYLOAD = {
  deposit: { USDC: { enabled: true, min_amount: 5, max_amount: 1000, fee_percent: 1.5 } },
  withdraw: { USDC: { enabled: true, min_amount: 5, max_amount: 1000 } },
  fee: { enabled: false },
  features: { account_creation: false, claimable_balances: false },
}

const respondWith = (body: unknown, ok = true) =>
  vi.fn().mockResolvedValue({ ok, json: () => Promise.resolve(body) })

let logged: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  logged = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  logged.mockRestore()
  vi.unstubAllGlobals()
})

describe('fetchAnchorFees', () => {
  it('reads each direction from the path the anchor actually publishes', async () => {
    vi.stubGlobal('fetch', respondWith(LIVE_INFO_PAYLOAD))

    expect(await fetchAnchorFees()).toEqual({ depositPercent: 1.5, withdrawPercent: null, minAmount: 5, maxAmount: 1000 })
  })

  it('reports the fee the anchor publishes, whatever it is', async () => {
    vi.stubGlobal('fetch', respondWith({ deposit: { USDC: { fee_percent: 2.75 } }, withdraw: { USDC: { fee_percent: 0.5 } } }))

    expect(await fetchAnchorFees()).toEqual({ depositPercent: 2.75, withdrawPercent: 0.5, minAmount: null, maxAmount: null })
  })

  it('a zero fee is a published fee, not a missing one', async () => {
    vi.stubGlobal('fetch', respondWith({ deposit: { USDC: { fee_percent: 0 } }, withdraw: { USDC: {} } }))

    expect(await fetchAnchorFees()).toEqual({ depositPercent: 0, withdrawPercent: null, minAmount: null, maxAmount: null })
  })

  it('a zero minimum is a published limit, not a missing one', async () => {
    vi.stubGlobal('fetch', respondWith({ deposit: { USDC: { min_amount: 0, max_amount: 1000 } } }))

    expect(await fetchAnchorFees()).toEqual({ depositPercent: null, withdrawPercent: null, minAmount: 0, maxAmount: 1000 })
  })

  it('reads the limits from the deposit side only, matching what withdraw-door.e2e-spec.ts pins as always equal to it', async () => {
    vi.stubGlobal(
      'fetch',
      respondWith({ deposit: { USDC: { min_amount: 5, max_amount: 1000 } }, withdraw: { USDC: { min_amount: 999, max_amount: 999999 } } }),
    )

    expect(await fetchAnchorFees()).toEqual({ depositPercent: null, withdrawPercent: null, minAmount: 5, maxAmount: 1000 })
  })

  it('yields null for both directions when the anchor is unreachable, and never throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await expect(fetchAnchorFees()).resolves.toEqual({ depositPercent: null, withdrawPercent: null, minAmount: null, maxAmount: null })
  })

  it('yields null on a non-ok response', async () => {
    vi.stubGlobal('fetch', respondWith(LIVE_INFO_PAYLOAD, false))

    expect(await fetchAnchorFees()).toEqual({ depositPercent: null, withdrawPercent: null, minAmount: null, maxAmount: null })
  })

  it('yields null when the body is not the shape the anchor documents', async () => {
    vi.stubGlobal('fetch', respondWith({ deposit: { USDC: { fee_percent: 'free' } } }))
    expect(await fetchAnchorFees()).toEqual({ depositPercent: null, withdrawPercent: null, minAmount: null, maxAmount: null })

    vi.stubGlobal('fetch', respondWith({}))
    expect(await fetchAnchorFees()).toEqual({ depositPercent: null, withdrawPercent: null, minAmount: null, maxAmount: null })

    vi.stubGlobal('fetch', respondWith(null))
    expect(await fetchAnchorFees()).toEqual({ depositPercent: null, withdrawPercent: null, minAmount: null, maxAmount: null })
  })

  it('yields null rather than a NaN when the fee is not finite', async () => {
    vi.stubGlobal('fetch', respondWith({ deposit: { USDC: { fee_percent: Number.NaN } } }))

    const fees = await fetchAnchorFees()
    expect(fees).toEqual({ depositPercent: null, withdrawPercent: null, minAmount: null, maxAmount: null })
    expect(Number.isNaN(fees.depositPercent)).toBe(false)
  })

  it('yields null when the body is not JSON at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => Promise.reject(new SyntaxError('Unexpected token <')) }))

    await expect(fetchAnchorFees()).resolves.toEqual({ depositPercent: null, withdrawPercent: null, minAmount: null, maxAmount: null })
  })

  it('leaves a trace naming the status when the anchor refuses, instead of degrading silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: () => Promise.resolve({}) }))

    await fetchAnchorFees()

    expect(logged).toHaveBeenCalledTimes(1)
    expect(String(logged.mock.calls[0])).toContain('429')
  })

  it('leaves a trace naming the error when the fetch throws, instead of degrading silently', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')))

    await fetchAnchorFees()

    expect(logged).toHaveBeenCalledTimes(1)
    expect(String(logged.mock.calls[0])).toContain('ECONNREFUSED')
  })

  it('says nothing when the anchor answers, so a line in the journal means something went wrong', async () => {
    vi.stubGlobal('fetch', respondWith(LIVE_INFO_PAYLOAD))

    await fetchAnchorFees()

    expect(logged).not.toHaveBeenCalled()
  })
})
