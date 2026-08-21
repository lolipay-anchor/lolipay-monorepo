import { render, screen, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Countdown } from '../Countdown'

describe('Countdown', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('ticks m:ss down every second', () => {
    render(<Countdown deadline={Date.now() + 125_000} />)
    expect(screen.getByText('2:05')).toBeInTheDocument()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByText('2:04')).toBeInTheDocument()
  })
  it('turns danger under the warn threshold and fires onExpire once at 0', () => {
    const onExpire = vi.fn()
    render(<Countdown deadline={Date.now() + 2_000} onExpire={onExpire} />)
    expect(screen.getByText('0:02')).toHaveClass('text-lp-danger')
    act(() => vi.advanceTimersByTime(3000))
    expect(screen.getByText('0:00')).toBeInTheDocument()
    expect(onExpire).toHaveBeenCalledOnce()
  })

  it('re-arms onExpire when deadline changes to a new future time', () => {
    const onExpire = vi.fn()
    const { rerender } = render(<Countdown deadline={Date.now() + 1_000} onExpire={onExpire} />)
    act(() => vi.advanceTimersByTime(1000))
    expect(onExpire).toHaveBeenCalledTimes(1)

    rerender(<Countdown deadline={Date.now() + 1_000} onExpire={onExpire} />)
    act(() => vi.advanceTimersByTime(1000))
    expect(onExpire).toHaveBeenCalledTimes(2)
  })

  it('fires onExpire immediately when deadline is already past at mount', () => {
    const onExpire = vi.fn()
    render(<Countdown deadline={Date.now() - 1_000} onExpire={onExpire} />)
    expect(onExpire).toHaveBeenCalledOnce()
  })
})
