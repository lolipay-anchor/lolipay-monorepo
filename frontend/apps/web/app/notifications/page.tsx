'use client'

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getNotifications, markNotificationsRead } from '@lolipay/api-client'
import { Bell } from 'lucide-react'
import { SkeletonList, NAV_CLEARANCE_CLASS } from '@lolipay/ui'
import { AppHeader } from '@/components/AppHeader'
import { client } from '@/lib/client'
import { timeAgo } from '@/lib/format'

export default function NotificationsPage() {
  const qc = useQueryClient()
  const { data, isLoading, error } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => getNotifications(client),
  })

  React.useEffect(() => {
    markNotificationsRead(client)
      .then(() => qc.invalidateQueries({ queryKey: ['notifications-unread'] }))
      .catch(() => {})
  }, [qc])

  return (
    <div className={`flex min-h-screen flex-col bg-lp-paper ${NAV_CLEARANCE_CLASS}`}>
      <AppHeader showBack title="Notifications" />
      <main className="flex-1 px-[18px] pt-1 animate-lp-rise">
        {isLoading && <SkeletonList rows={4} />}
        {error && (
          <p className="py-10 text-center text-sm text-lp-danger">Failed to load notifications.</p>
        )}
        {data && data.items.length === 0 && (
          <p className="px-5 py-11 text-center text-[13px] leading-relaxed text-lp-muted">
            No notifications yet. Order events from providers and operators land here.
          </p>
        )}
        {data && data.items.length > 0 && (
          <div className="flex flex-col gap-2.5">
            {data.items.map((n) => (
              <div
                key={n.id}
                data-testid="notification-row"
                className="flex items-start gap-[11px] rounded-2xl border border-lp-line bg-lp-surface p-[13px_15px]"
              >
                <span className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-full bg-lp-line-2">
                  <Bell size={16} strokeWidth={1.9} className="text-lp-ink" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-lp-ink">{n.title}</p>
                  <p className="mt-0.5 text-[13px] leading-snug text-lp-ink-soft">{n.body}</p>
                  <p className="mt-[3px] font-geist-mono text-[10.5px] text-lp-faint">
                    {timeAgo(n.createdAt)}
                  </p>
                </div>
                {!n.read && (
                  <span
                    className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-lp-accent"
                    aria-label="unread"
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
