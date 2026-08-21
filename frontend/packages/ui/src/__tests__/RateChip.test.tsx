import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { RateChip } from '../RateChip'
describe('RateChip', () => {
  it('formats countdown mm:ss with the rate', () => {
    render(<RateChip rate="1 USDC = Rp 16,240" secondsLeft={118} />)
    expect(screen.getByText(/1 USDC = Rp 16,240 · 1:58/)).toBeTruthy()
  })
})
