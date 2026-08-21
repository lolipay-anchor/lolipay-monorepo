import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QuoteBreakdown } from '@/components/QuoteBreakdown'

describe('QuoteBreakdown', () => {
  it('renders each row and marks the strong net row', () => {
    render(
      <QuoteBreakdown
        rows={[
          { label: 'Rate', value: '1 USDC = Rp 16.350' },
          { label: 'Fee', value: '0.50 USDC · Rp 8.175' },
          { label: 'You get', value: '98.50 USDC', strong: true },
        ]}
      />,
    )
    expect(screen.getByText('Rate')).toBeTruthy()
    expect(screen.getByText('1 USDC = Rp 16.350')).toBeTruthy()
    expect(screen.getByText('0.50 USDC · Rp 8.175')).toBeTruthy()
    expect(screen.getByTestId('quote-net').textContent).toBe('98.50 USDC')
  })
})
