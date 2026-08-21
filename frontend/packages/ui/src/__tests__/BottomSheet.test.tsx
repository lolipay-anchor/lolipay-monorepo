import * as React from 'react'
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { BottomSheet } from '../BottomSheet'

describe('BottomSheet', () => {
  it('renders nothing when closed', () => {
    render(
      <BottomSheet open={false} onClose={() => {}}>
        <p>Content</p>
      </BottomSheet>,
    )
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('exposes dialog semantics when open', () => {
    render(
      <BottomSheet open onClose={() => {}} ariaLabel="Confirm">
        <p>Content</p>
      </BottomSheet>,
    )
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(dialog.getAttribute('aria-label')).toBe('Confirm')
  })

  it('closes on Escape', () => {
    const onClose = vi.fn()
    render(
      <BottomSheet open onClose={onClose} ariaLabel="Confirm">
        <button type="button">Cancel</button>
      </BottomSheet>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on scrim click (existing behavior preserved)', () => {
    const onClose = vi.fn()
    const { container } = render(
      <BottomSheet open onClose={onClose} ariaLabel="Confirm">
        <button type="button">Cancel</button>
      </BottomSheet>,
    )
    const scrim = container.querySelector('.bg-lp-ink\\/40')
    expect(scrim).toBeTruthy()
    fireEvent.click(scrim as Element)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('focuses the first focusable element inside the sheet on open', () => {
    render(
      <BottomSheet open onClose={() => {}} ariaLabel="Confirm">
        <button type="button">First</button>
        <button type="button">Second</button>
      </BottomSheet>,
    )
    expect(document.activeElement?.textContent).toBe('First')
  })

  it('traps Tab focus within the sheet', () => {
    render(
      <BottomSheet open onClose={() => {}} ariaLabel="Confirm">
        <button type="button">First</button>
        <button type="button">Second</button>
      </BottomSheet>,
    )
    const first = screen.getByText('First')
    const second = screen.getByText('Second')

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(second)

    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(first)
  })

  it('does NOT close on Escape when dismissible=false', () => {
    const onClose = vi.fn()
    render(
      <BottomSheet open onClose={onClose} ariaLabel="Confirm" dismissible={false}>
        <button type="button">Cancel</button>
      </BottomSheet>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
  })

  it('does NOT close on scrim click when dismissible=false', () => {
    const onClose = vi.fn()
    const { container } = render(
      <BottomSheet open onClose={onClose} ariaLabel="Confirm" dismissible={false}>
        <button type="button">Cancel</button>
      </BottomSheet>,
    )
    const scrim = container.querySelector('.bg-lp-ink\\/40')
    expect(scrim).toBeTruthy()
    fireEvent.click(scrim as Element)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('still closes on Escape and scrim click when dismissible is left at its default (true)', () => {
    const onClose = vi.fn()
    const { container } = render(
      <BottomSheet open onClose={onClose} ariaLabel="Confirm">
        <button type="button">Cancel</button>
      </BottomSheet>,
    )
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    const scrim = container.querySelector('.bg-lp-ink\\/40')
    fireEvent.click(scrim as Element)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('restores focus to the previously focused element on close', () => {
    function Harness() {
      const [open, setOpen] = React.useState(false)
      return (
        <div>
          <button type="button" onClick={() => setOpen(true)}>
            Open
          </button>
          <BottomSheet open={open} onClose={() => setOpen(false)} ariaLabel="Confirm">
            <button type="button">Inside</button>
          </BottomSheet>
        </div>
      )
    }
    render(<Harness />)
    const trigger = screen.getByText('Open')
    trigger.focus()
    expect(document.activeElement).toBe(trigger)

    fireEvent.click(trigger)
    expect(document.activeElement?.textContent).toBe('Inside')

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.activeElement).toBe(trigger)
  })
})
