import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { NotificationBell } from '../NotificationBell'

describe('NotificationBell', () => {
  it('shows the unread dot only when unread > 0', () => {
    const { rerender } = render(<NotificationBell unread={3} />)
    expect(screen.getByTestId('bell-dot')).toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveAccessibleName('Notifications (3 unread)')
    rerender(<NotificationBell unread={0} />)
    expect(screen.queryByTestId('bell-dot')).toBeNull()
  })
})
