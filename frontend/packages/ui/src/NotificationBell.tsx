import * as React from 'react'
import { Bell } from 'lucide-react'

export interface NotificationBellProps {
  unread?: number; href: string; className?: string
}

export function NotificationBell({ unread = 0, href, className = '' }: NotificationBellProps) {
  return (
    <a href={href}
      aria-label={unread > 0 ? `Notifications (${unread} unread)` : 'Notifications'}
      className={`relative flex h-[38px] w-[38px] items-center justify-center rounded-xl border border-lp-line bg-lp-surface ${className}`}>
      <Bell size={18} strokeWidth={1.9} className="text-lp-ink" />
      {unread > 0 && <span data-testid="bell-dot" className="absolute right-2 top-2 h-2 w-2 rounded-full bg-lp-accent" />}
    </a>
  )
}
