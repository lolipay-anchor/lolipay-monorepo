'use client'

import * as React from 'react'
import {
  connectRealtime,
  type OrderUpdatePayload,
  type AssignmentsChangedPayload,
  type Socket,
} from '@lolipay/api-client'
import { useAuth } from '@/app/providers'
import { client } from '@/lib/client'

export interface UseRealtimeChannelOptions {
  orderIds?: string[]

  onOrderUpdate?: (payload: OrderUpdatePayload) => void

  onAssignmentsChanged?: (payload: AssignmentsChangedPayload) => void
}

export function useRealtimeChannel({
  orderIds,
  onOrderUpdate,
  onAssignmentsChanged,
}: UseRealtimeChannelOptions): void {
  const { token } = useAuth()

  const onOrderUpdateRef = React.useRef(onOrderUpdate)
  onOrderUpdateRef.current = onOrderUpdate
  const onAssignmentsChangedRef = React.useRef(onAssignmentsChanged)
  onAssignmentsChangedRef.current = onAssignmentsChanged

  const orderIdsKey = orderIds && orderIds.length > 0 ? orderIds.join(',') : ''

  React.useEffect(() => {
    if (!token) return undefined

    let socket: Socket | undefined
    try {
      socket = connectRealtime({ baseUrl: client.baseUrl, token })

      const ids = orderIdsKey ? orderIdsKey.split(',') : []

      socket.on('connect', () => {
        for (const id of ids) socket?.emit('join:order', { orderId: id })
      })

      socket.on('order:update', (payload: OrderUpdatePayload) => {
        onOrderUpdateRef.current?.(payload)
      })
      socket.on('assignments:changed', (payload: AssignmentsChangedPayload) => {
        onAssignmentsChangedRef.current?.(payload)
      })

      socket.on('connect_error', () => {})
      socket.on('error', () => {})
    } catch {
    }

    return () => {
      socket?.disconnect()
    }
  }, [token, orderIdsKey])
}
