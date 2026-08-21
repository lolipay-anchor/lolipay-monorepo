import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SegmentProgress } from '../SegmentProgress'

describe('SegmentProgress', () => {
  it('fills `done` of `total` segments with accent', () => {
    render(<SegmentProgress done={2} />)
    const bar = screen.getByRole('progressbar')
    expect(bar).toHaveAttribute('aria-valuenow', '2')
    expect(bar.querySelectorAll('.bg-lp-accent')).toHaveLength(2)
    expect(bar.querySelectorAll('.bg-lp-line-2')).toHaveLength(2)
  })
  it('clamps done above total', () => {
    render(<SegmentProgress total={4} done={9} />)
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '4')
  })
})
