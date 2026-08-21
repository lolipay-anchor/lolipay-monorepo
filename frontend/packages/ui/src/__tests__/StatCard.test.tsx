import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { StatCard } from '../StatCard'

describe('StatCard', () => {
  it('renders uppercase label and tabular value', () => {
    render(<StatCard label="Orders today" value="12" sub="+3 vs yesterday" />)
    expect(screen.getByText('Orders today')).toHaveClass('uppercase')
    expect(screen.getByText('12')).toHaveClass('tabular-nums')
    expect(screen.getByText('+3 vs yesterday')).toBeInTheDocument()
  })
})
