import { vi } from 'vitest'

export function makeFakeSocket() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    const arr = listeners.get(event) ?? []
    arr.push(cb)
    listeners.set(event, arr)
  })
  const off = vi.fn((event: string, cb?: (...args: unknown[]) => void) => {
    if (!cb) {
      listeners.delete(event)
      return
    }
    listeners.set(event, (listeners.get(event) ?? []).filter((f) => f !== cb))
  })
  const emit = vi.fn()
  const disconnect = vi.fn()

  return {
    on,
    off,
    emit,
    disconnect,

    __trigger(event: string, payload?: unknown) {
      for (const cb of listeners.get(event) ?? []) cb(payload)
    },
  }
}

export type FakeSocket = ReturnType<typeof makeFakeSocket>
