'use client'

import * as React from 'react'
import Link from 'next/link'
import { Bell } from 'lucide-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getNotifications } from '@lolipay/api-client'
import { client } from '@/lib/client'
import { useAuth } from '@/app/providers'
import { useRealtimeChannel } from '@/hooks/useRealtimeChannel'

export function NotificationBell() {
  const { token } = useAuth()
  const queryClient = useQueryClient()
  const { data } = useQuery({
    queryKey: ['notifications-unread'],
    queryFn: () => getNotifications(client),
    enabled: !!token,
    refetchInterval: 15_000,
  })

  useRealtimeChannel({
    onOrderUpdate: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications-unread'] })
    },
  })

  if (!token) return null
  const unread = data?.unread ?? 0

  return (
    <Link
      href="/notifications"
      className="relative flex h-[38px] w-[38px] items-center justify-center rounded-xl border border-lp-line bg-lp-surface"
      aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
    >
      <Bell size={18} strokeWidth={1.9} className="text-lp-ink" />
      {unread > 0 && (
        <span
          data-testid="bell-dot"
          className="absolute right-2 top-2 h-2 w-2 rounded-full border-[1.5px] border-lp-surface bg-lp-accent"
        />
      )}
    </Link>
  )
}
