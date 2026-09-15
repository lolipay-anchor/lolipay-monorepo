import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { NotificationBell } from '../NotificationBell'

describe('NotificationBell', () => {
  it('shows the unread dot only when unread > 0', () => {
    const { rerender } = render(<NotificationBell unread={3} href="/notifications" />)
    expect(screen.getByTestId('bell-dot')).toBeInTheDocument()
    expect(screen.getByRole('link')).toHaveAccessibleName('Notifications (3 unread)')
    rerender(<NotificationBell unread={0} href="/notifications" />)
    expect(screen.queryByTestId('bell-dot')).toBeNull()
  })

  it('is a link to the href it was given, never a button carrying a handler', () => {
    render(<NotificationBell href="/notifications" />)
    expect(screen.getByRole('link', { name: 'Notifications' })).toHaveAttribute('href', '/notifications')
    expect(screen.queryByRole('button')).toBeNull()
  })
})
