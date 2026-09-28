import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const mod = await importOriginal<any>()
  return { ...mod, getRate: vi.fn().mockResolvedValue({ asset: 'USDC', fiat: 'IDR', rate: '16000', ts: '2026-07-07T00:00:00Z' }) }
})
import { getRate } from '@lolipay/api-client'
import { BuySellWidget } from '../components/BuySellWidget'
import { NO_ANCHOR_FEES, type AnchorFees } from '../lib/anchor-fees'

const ANCHOR_DEPOSIT_FEE_PERCENT = 1.5
const FEES: AnchorFees = { depositPercent: ANCHOR_DEPOSIT_FEE_PERCENT, withdrawPercent: 2 }

const valueBeside = (label: string) => screen.getByText(label).nextSibling?.textContent

describe('BuySellWidget', () => {
  beforeEach(() => {
    vi.mocked(getRate).mockClear()
  })

  it('shows live IDR estimate once the rate loads', async () => {
    render(<BuySellWidget fees={FEES} />)
    await waitFor(() => expect(screen.getByText(/live rate/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }))

    expect(screen.getByText('30.78')).toBeInTheDocument()
    expect(screen.getByText(/1 USDC = Rp 16\.000/)).toBeInTheDocument()
  })

  it('quotes the deposit fee the anchor publishes, not a fee of its own', async () => {
    render(<BuySellWidget fees={FEES} />)
    await waitFor(() => expect(screen.getByText(/live rate/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }))

    const gross = 500000 / 16000
    expect(valueBeside('Network + LP fee')).toBe(`${(gross * (ANCHOR_DEPOSIT_FEE_PERCENT / 100)).toFixed(2)} USDC`)
    expect(valueBeside('You receive')).toContain((gross * (1 - ANCHOR_DEPOSIT_FEE_PERCENT / 100)).toFixed(2))
  })

  it('a different published fee moves the quote', async () => {
    render(<BuySellWidget fees={{ depositPercent: 3, withdrawPercent: 2 }} />)
    await waitFor(() => expect(screen.getByText(/live rate/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }))

    expect(valueBeside('Network + LP fee')).toBe('0.94 USDC')
    expect(valueBeside('You receive')).toContain('30.31')
    expect(screen.queryByText('30.78')).not.toBeInTheDocument()
  })

  it('sell tab converts USDC to IDR using the withdraw fee, not the deposit one', async () => {
    render(<BuySellWidget fees={FEES} />)
    await waitFor(() => screen.getByText(/live rate/i))
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }))

    expect(screen.getByText('470.400')).toBeInTheDocument()
    expect(screen.queryByText('472.800')).not.toBeInTheDocument()
    expect(valueBeside('Network + LP fee')).toBe('Rp 9.600')
  })

  it('renders no fee-bearing figure at all when the anchor publishes no fee', async () => {
    render(<BuySellWidget fees={NO_ANCHOR_FEES} />)
    await waitFor(() => expect(screen.getByText(/live rate/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }))

    expect(valueBeside('You receive')).toContain('—')
    expect(valueBeside('Network + LP fee')).toBe('—')

    expect(screen.queryByText('30.78')).not.toBeInTheDocument()
    expect(screen.queryByText(/31[.,]25/)).not.toBeInTheDocument()
    expect(screen.queryByText(/0[.,]47/)).not.toBeInTheDocument()

    expect(valueBeside('Rate')).toBe('1 USDC = Rp 16.000')
  })

  it('withholds only the direction the anchor has not published: buy quotes, sell shows no figure it cannot derive', async () => {
    render(<BuySellWidget fees={{ depositPercent: ANCHOR_DEPOSIT_FEE_PERCENT, withdrawPercent: null }} />)
    await waitFor(() => expect(screen.getByText(/live rate/i)).toBeInTheDocument())

    fireEvent.click(screen.getByRole('button', { name: 'Buy' }))
    expect(valueBeside('You receive')).toContain('30.78')

    fireEvent.click(screen.getByRole('button', { name: 'Sell' }))
    expect(valueBeside('You receive')).toContain('—')
    expect(valueBeside('Network + LP fee')).toBe('—')
    expect(valueBeside('Rate')).toBe('1 USDC = Rp 16.000')

    expect(screen.queryByText('470.400')).not.toBeInTheDocument()
    expect(screen.queryByText('478.560')).not.toBeInTheDocument()
    expect(screen.queryByText('480.000')).not.toBeInTheDocument()
  })

  it('never reaches for the deposit fee to quote a withdrawal', async () => {
    render(<BuySellWidget fees={{ depositPercent: ANCHOR_DEPOSIT_FEE_PERCENT, withdrawPercent: null }} />)
    await waitFor(() => expect(screen.getByText(/live rate/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Sell' }))

    const ifItBorrowedTheDepositFee = (30 * (1 - ANCHOR_DEPOSIT_FEE_PERCENT / 100) * 16000).toLocaleString('id-ID')
    expect(screen.queryByText(ifItBorrowedTheDepositFee)).not.toBeInTheDocument()
    expect(valueBeside('You receive')).toContain('—')
  })

  it('non-IDR markets are shown but not selectable', async () => {
    render(<BuySellWidget fees={FEES} />)
    fireEvent.click(screen.getByRole('button', { name: /indonesia/i }))
    const ph = screen.getByRole('button', { name: /philippines/i })
    expect(ph).toBeDisabled()
    expect(screen.getAllByText(/coming soon/i).length).toBe(5)
  })

  it('falls back to indicative rate when the API fails', async () => {
    vi.mocked(getRate).mockRejectedValueOnce(new Error('down'))
    render(<BuySellWidget fees={FEES} />)
    await waitFor(() => expect(screen.getByText(/indicative rate/i)).toBeInTheDocument())
  })

  it('shows — (never the hardcoded 16732 base) before the live rate resolves, then the real value once it does', async () => {
    let resolveRate!: (v: unknown) => void
    const pending = new Promise((res) => {
      resolveRate = res
    })
    vi.mocked(getRate).mockReturnValueOnce(pending as ReturnType<typeof getRate>)

    render(<BuySellWidget fees={FEES} />)
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }))

    expect(screen.queryByText(/16[.,]732/)).not.toBeInTheDocument()
    expect(valueBeside('Rate')).toBe('—')
    expect(valueBeside('You receive')).toContain('—')

    await act(async () => {
      resolveRate({ asset: 'USDC', fiat: 'IDR', rate: '16000', ts: '2026-07-07T00:00:00Z' })
      await pending
    })

    await waitFor(() => expect(screen.getByText(/live rate/i)).toBeInTheDocument())

    expect(screen.getByText('30.78')).toBeInTheDocument()
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

      render(<BuySellWidget fees={FEES} />)
      fireEvent.click(screen.getByRole('button', { name: 'Buy' }))

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(screen.getByText(/live rate/i)).toBeInTheDocument()

      expect(screen.getByText('30.78')).toBeInTheDocument()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000)
      })

      expect(screen.getByText(/indicative rate/i)).toBeInTheDocument()

      expect(screen.getByText('30.78')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
      vi.mocked(getRate).mockReset()
      vi.mocked(getRate).mockResolvedValue({ asset: 'USDC', fiat: 'IDR', rate: '16000', ts: '2026-07-07T00:00:00Z' })
    }
  })
})
