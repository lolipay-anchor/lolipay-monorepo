import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const mod = await importOriginal<any>()
  return { ...mod, getRate: vi.fn().mockResolvedValue({ asset: 'USDC', fiat: 'IDR', rate: '16000', ts: '2026-07-07T00:00:00Z' }) }
})

import Home from '../app/page'

describe('landing smoke', () => {
  it('renders the hero and the buy/sell widget', () => {
    render(<Home />)
    expect(screen.getByRole('heading', { name: /spend crypto/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Buy' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sell' })).toBeInTheDocument()
    expect(screen.getByText(/connect wallet to continue/i)).toBeInTheDocument()
  })
})
