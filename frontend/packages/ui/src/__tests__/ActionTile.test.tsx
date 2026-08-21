import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { ActionTile } from '../ActionTile'

describe('ActionTile', () => {
  it('fires onClick and defaults to the light look', () => {
    const onClick = vi.fn()
    render(<ActionTile icon={<svg data-testid="i" />} label="Buy" onClick={onClick} />)
    fireEvent.click(screen.getByRole('button', { name: /Buy/ }))
    expect(onClick).toHaveBeenCalledOnce()
    expect(screen.getByRole('button')).toHaveClass('bg-lp-surface')
  })
  it('primary variant is dark (Pay bill tile)', () => {
    render(<ActionTile icon={<svg />} label="Pay bill" sub="QRIS" variant="primary" />)
    expect(screen.getByRole('button')).toHaveClass('bg-lp-ink')
    expect(screen.getByText('QRIS')).toBeInTheDocument()
  })
  it('is center-aligned (icon+label centered, not pinned left) for mobile tap precision', () => {
    render(<ActionTile icon={<svg data-testid="i" />} label="Buy" />)
    const button = screen.getByRole('button')
    expect(button).toHaveClass('items-center')
    expect(button).toHaveClass('text-center')
    expect(button).not.toHaveClass('items-start')
    expect(button).not.toHaveClass('text-left')
  })
})
