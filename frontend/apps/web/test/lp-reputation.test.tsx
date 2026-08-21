import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LpReputationCard } from '@/components/LpReputationCard'

describe('LpReputationCard', () => {
  it('shows rounded completion %, trade count and online dot', () => {
    render(
      <LpReputationCard
        rep={{ completed_trades: 42, completion_rate: 0.977, member_since: '2026-01-15T00:00:00Z', online: true }}
      />,
    )
    expect(screen.getByTestId('lp-completion').textContent).toBe('98%')
    expect(screen.getByText(/42 trades/)).toBeTruthy()
    expect(screen.getByLabelText('Online')).toBeTruthy()
  })

  it('shows "New LP" and singular "trade" appropriately', () => {
    render(
      <LpReputationCard
        rep={{ completed_trades: 1, completion_rate: null, member_since: '2026-06-01T00:00:00Z', online: false }}
      />,
    )
    expect(screen.getByTestId('lp-completion').textContent).toBe('New LP')
    expect(screen.getByText(/1 trade$/)).toBeTruthy()
    expect(screen.getByLabelText('Offline')).toBeTruthy()
  })
})
