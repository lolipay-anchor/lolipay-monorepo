import * as React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ReviewSheet } from '@/components/ReviewSheet'

const rows = {
  youPay: 'Rp 1.624.000',
  youReceive: '99.97 USDC',
  rate: '1 USDC = Rp 16.000',
  rateHeldSecondsLeft: 95,
}

describe('ReviewSheet', () => {
  it('renders nothing when closed', () => {
    render(
      <ReviewSheet open={false} onClose={vi.fn()} onConfirm={vi.fn()} confirming={false} rows={rows} />,
    )
    expect(screen.queryByText('Review order')).toBeNull()
  })

  it('shows the title, the value rows, and the exact escrow note — no itemized fee row', () => {
    render(<ReviewSheet open onClose={vi.fn()} onConfirm={vi.fn()} confirming={false} rows={rows} />)

    expect(screen.getByText('Review order')).toBeTruthy()
    expect(screen.getByText('Rp 1.624.000')).toBeTruthy()
    expect(screen.getByText('99.97 USDC')).toBeTruthy()
    expect(screen.getByText('1 USDC = Rp 16.000')).toBeTruthy()
    expect(screen.getByText('Rate · held 1:35')).toBeTruthy()
    expect(
      screen.getByText(
        "Funds are held in on-chain escrow and released only when both sides confirm. If anything goes wrong, you're refunded.",
      ),
    ).toBeTruthy()

    expect(screen.queryByText(/fee/i)).toBeNull()
  })

  it('omits "held m:ss" when rateHeldSecondsLeft is not given', () => {
    const { rateHeldSecondsLeft: _omit, ...rest } = rows
    render(<ReviewSheet open onClose={vi.fn()} onConfirm={vi.fn()} confirming={false} rows={rest} />)
    expect(screen.getByText('Rate')).toBeTruthy()
    expect(screen.queryByText(/Rate · held/)).toBeNull()
  })

  it('calls onConfirm when the CTA is clicked, and disables the CTA while confirming', () => {
    const onConfirm = vi.fn()
    const { rerender } = render(
      <ReviewSheet open onClose={vi.fn()} onConfirm={onConfirm} confirming={false} rows={rows} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Confirm — sign/i }))
    expect(onConfirm).toHaveBeenCalledTimes(1)

    rerender(<ReviewSheet open onClose={vi.fn()} onConfirm={onConfirm} confirming rows={rows} />)
    expect(screen.getByRole('button', { name: /loading/i })).toBeDisabled()
  })

  it('calls onClose when Back is clicked', () => {
    const onClose = vi.fn()
    render(<ReviewSheet open onClose={onClose} onConfirm={vi.fn()} confirming={false} rows={rows} />)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('supports a custom confirmLabel', () => {
    render(
      <ReviewSheet
        open
        onClose={vi.fn()}
        onConfirm={vi.fn()}
        confirming={false}
        rows={rows}
        confirmLabel="Lock & pay"
      />,
    )
    expect(screen.getByRole('button', { name: 'Lock & pay' })).toBeTruthy()
  })
})
