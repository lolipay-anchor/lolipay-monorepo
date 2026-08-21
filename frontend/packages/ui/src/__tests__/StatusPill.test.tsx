import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { StatusPill } from '../StatusPill'

describe('StatusPill', () => {
  it('applies the tone pair from the redesign palette', () => {
    render(<StatusPill tone="green">Settled</StatusPill>)
    expect(screen.getByText('Settled').closest('span')).toHaveClass('bg-lp-green-soft')
  })
  it('shows a pulsing dot only when pulse is set', () => {
    const { rerender } = render(<StatusPill tone="accent" pulse>Live</StatusPill>)
    expect(screen.getByTestId('pill-dot')).toHaveClass('animate-lp-pulse')
    rerender(<StatusPill tone="accent">Live</StatusPill>)
    expect(screen.queryByTestId('pill-dot')).toBeNull()
  })
})
