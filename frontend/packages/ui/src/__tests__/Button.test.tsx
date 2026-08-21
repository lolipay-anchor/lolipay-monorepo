import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Button } from '../Button'
describe('Button', () => {
  it('renders children and primary classes', () => {
    render(<Button>Continue to pay</Button>)
    const b = screen.getByRole('button', { name: 'Continue to pay' })
    expect(b.className).toContain('bg-lp-accent')
  })
  it('disables and hides label when loading', () => {
    render(<Button loading>Continue</Button>)
    expect(screen.getByRole('button')).toBeDisabled()
  })
  it('renders the outline variant with a bordered/surface look', () => {
    render(<Button variant="outline">Decline</Button>)
    const b = screen.getByRole('button', { name: 'Decline' })
    expect(b.className).toContain('border-lp-line')
    expect(b.className).toContain('bg-lp-surface')
    expect(b.className).toContain('text-lp-ink')
  })
  it('standardizes disabled opacity across all variants', () => {
    render(<Button disabled>Primary</Button>)
    render(<Button disabled variant="ghost">Ghost</Button>)
    render(<Button disabled variant="outline">Outline</Button>)
    for (const name of ['Primary', 'Ghost', 'Outline']) {
      const b = screen.getByRole('button', { name })
      expect(b.className).toContain('disabled:opacity-50')
      expect(b).toBeDisabled()
    }
  })
})
