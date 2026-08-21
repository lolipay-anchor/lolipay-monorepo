import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { DarkHeroCard } from '../DarkHeroCard'

describe('DarkHeroCard', () => {
  it('renders children on the dark ink surface', () => {
    render(<DarkHeroCard><span>Rp 16.240</span></DarkHeroCard>)
    expect(screen.getByTestId('dark-hero')).toHaveClass('bg-lp-ink')
    expect(screen.getByText('Rp 16.240')).toBeInTheDocument()
  })
})
