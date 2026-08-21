import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const mod = await importOriginal<any>()
  return { ...mod, getRate: vi.fn().mockResolvedValue({ asset: 'USDC', fiat: 'IDR', rate: '16000', ts: '2026-07-07T00:00:00Z' }) }
})
import { getRate } from '@lolipay/api-client'
import { BuySellWidget } from '../components/BuySellWidget'

describe('BuySellWidget', () => {
  beforeEach(() => {
    vi.mocked(getRate).mockClear()
  })

  it('shows live IDR estimate once the rate loads', async () => {
    render(<BuySellWidget />)
    await waitFor(() => expect(screen.getByText(/live rate/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }))

    expect(screen.getByText('31.16')).toBeInTheDocument()
    expect(screen.getByText(/1 USDC = Rp 16\.000/)).toBeInTheDocument()
  })
  it('sell tab converts USDC to IDR', async () => {
    render(<BuySellWidget />)
    await waitFor(() => screen.getByText(/live rate/i))
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }))

    expect(screen.getByText('478.560')).toBeInTheDocument()
  })
  it('non-IDR markets are shown but not selectable', async () => {
    render(<BuySellWidget />)
    fireEvent.click(screen.getByRole('button', { name: /indonesia/i }))
    const ph = screen.getByRole('button', { name: /philippines/i })
    expect(ph).toBeDisabled()
    expect(screen.getAllByText(/coming soon/i).length).toBe(5)
  })
  it('falls back to indicative rate when the API fails', async () => {
    vi.mocked(getRate).mockRejectedValueOnce(new Error('down'))
    render(<BuySellWidget />)
    await waitFor(() => expect(screen.getByText(/indicative rate/i)).toBeInTheDocument())
  })

  it('shows — (never the hardcoded 16732 base) before the live rate resolves, then the real value once it does', async () => {
    let resolveRate!: (v: unknown) => void
    const pending = new Promise((res) => {
      resolveRate = res
    })
    vi.mocked(getRate).mockReturnValueOnce(pending as ReturnType<typeof getRate>)

    render(<BuySellWidget />)
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }))

    expect(screen.queryByText(/16[.,]732/)).not.toBeInTheDocument()
    expect(screen.getByText('Rate').nextSibling?.textContent).toBe('—')
    expect(screen.getByText('You receive').nextSibling?.textContent).toContain('—')

    await act(async () => {
      resolveRate({ asset: 'USDC', fiat: 'IDR', rate: '16000', ts: '2026-07-07T00:00:00Z' })
      await pending
    })

    await waitFor(() => expect(screen.getByText(/live rate/i)).toBeInTheDocument())

    expect(screen.getByText('31.16')).toBeInTheDocument()
    expect(screen.getByText(/1 USDC = Rp 16\.000/)).toBeInTheDocument()
  })

  it('keeps the last-known live rate (not the static base) when a later poll fails', async () => {
    vi.useFakeTimers()
    try {
      let call = 0
      vi.mocked(getRate).mockImplementation(() => {
        call += 1
        return call === 1 ? Promise.resolve({ asset: 'USDC', fiat: 'IDR', rate: '16000', ts: '2026-07-07T00:00:00Z' }) : Promise.reject(new Error('down'))
      })

      render(<BuySellWidget />)
      fireEvent.click(screen.getByRole('button', { name: 'Buy' }))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText(/live rate/i)).toBeInTheDocument()

      expect(screen.getByText('31.16')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000)
      })

      expect(screen.getByText(/indicative rate/i)).toBeInTheDocument()

      expect(screen.getByText('31.16')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
      vi.mocked(getRate).mockReset()
      vi.mocked(getRate).mockResolvedValue({ asset: 'USDC', fiat: 'IDR', rate: '16000', ts: '2026-07-07T00:00:00Z' })
    }
  })
})
