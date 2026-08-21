import { io, type Socket } from 'socket.io-client'

export interface OrderUpdatePayload {
  id: string
  status: string
  flow: string
  updated_at: string
}

export interface AssignmentsChangedPayload {
  orderId: string
  status: string
}

export interface JoinOrderErrorPayload {
  orderId?: string
  reason: string
}

export type { Socket }

export function connectRealtime(opts: { baseUrl: string; token: string }): Socket {
  return io(`${opts.baseUrl}/ws`, {
    auth: { token: opts.token },
    reconnection: true,
  })
}
