import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Home, ClipboardList } from 'lucide-react'
import { BottomNav } from '../BottomNav'

const items = [
  { key: 'home', label: 'Home', icon: <Home size={20} /> },
  { key: 'orders', label: 'Orders', icon: <ClipboardList size={20} /> },
]

describe('BottomNav', () => {
  it('marks the active item and fires onSelect', () => {
    const onSelect = vi.fn()
    render(<BottomNav items={items} active="home" onSelect={onSelect} />)
    expect(screen.getByRole('button', { name: /Home/ })).toHaveAttribute('aria-current', 'page')
    fireEvent.click(screen.getByRole('button', { name: /Orders/ }))
    expect(onSelect).toHaveBeenCalledWith('orders')
  })
  it('merges className onto the nav element', () => {
    render(<BottomNav items={items} active="home" onSelect={vi.fn()} className="custom-nav" />)
    expect(screen.getByRole('navigation')).toHaveClass('custom-nav')
  })
})
