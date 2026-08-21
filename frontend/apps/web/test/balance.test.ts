import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { fetchUsdcBalance, formatUsdcBalance } from '@/lib/balance'
import { useUsdcBalance } from '@/hooks/useUsdcBalance'
import { USDC_ISSUER } from '@/lib/usdcAsset'

const ISSUER = USDC_ISSUER

describe('fetchUsdcBalance', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it('returns the balance string when the account holds the USDC trustline', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        balances: [{ asset_code: 'TUSDC', asset_issuer: ISSUER, balance: '142.5000000' }],
      }),
    }) as any
    expect(await fetchUsdcBalance('GABC')).toBe('142.5000000')
  })

  it('returns null when the account has no USDC trustline', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ balances: [{ asset_type: 'native', balance: '100.0000000' }] }),
    }) as any
    expect(await fetchUsdcBalance('GABC')).toBeNull()
  })

  it('returns null on a 404 (account not created)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as any
    expect(await fetchUsdcBalance('GABC')).toBeNull()
  })

  it('throws on a 500 (other HTTP error)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500 }) as any
    await expect(fetchUsdcBalance('GABC')).rejects.toThrow()
  })

  it('throws on a network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any
    await expect(fetchUsdcBalance('GABC')).rejects.toThrow('network down')
  })
})

describe('formatUsdcBalance', () => {
  it('formats a whole-ish balance to 2dp', () => {
    expect(formatUsdcBalance('0')).toBe('0.00')
  })

  it('formats a typical Horizon balance (7dp) to 2dp', () => {
    expect(formatUsdcBalance('142.5000000')).toBe('142.50')
  })

  it('truncates (does not round) the fraction beyond 2dp', () => {
    expect(formatUsdcBalance('1234.9999999')).toBe('1,234.99')
  })

  it('thousands-groups the integer part', () => {
    expect(formatUsdcBalance('1234567.1000000')).toBe('1,234,567.10')
  })

  it('pads a short fraction to 2dp', () => {
    expect(formatUsdcBalance('5.1')).toBe('5.10')
  })
})

describe('useUsdcBalance', () => {
  let queryClient: QueryClient
  const realFetch = global.fetch
  const ISSUER = USDC_ISSUER

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    })
    global.fetch = realFetch
  })

  afterEach(() => {
    global.fetch = realFetch
  })

  const wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children)

  it('returns an undefined balance when no address is provided', () => {
    const { result } = renderHook(() => useUsdcBalance(undefined), { wrapper })
    expect(result.current.balance).toBeUndefined()
  })

  it('returns a string balance when the account holds the USDC trustline', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        balances: [{ asset_code: 'TUSDC', asset_issuer: ISSUER, balance: '142.5000000' }],
      }),
    }) as any

    const { result } = renderHook(() => useUsdcBalance('GABC'), { wrapper })

    await waitFor(() => {
      expect(result.current.balance).toBe('142.5000000')
    })
  })

  it('returns null balance when the account has no USDC trustline', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ balances: [{ asset_type: 'native', balance: '100.0000000' }] }),
    }) as any

    const { result } = renderHook(() => useUsdcBalance('GABC'), { wrapper })

    await waitFor(() => {
      expect(result.current.balance).toBeNull()
    })
  })

  it('has isLoading true while fetching', () => {
    global.fetch = vi.fn().mockImplementation(() => new Promise(() => {}))
    const { result } = renderHook(() => useUsdcBalance('GABC'), { wrapper })
    expect(result.current.isLoading).toBe(true)
  })
})
