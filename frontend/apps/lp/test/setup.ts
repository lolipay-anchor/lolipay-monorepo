import '@testing-library/jest-dom/vitest'
import { vi } from 'vitest'

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => ({
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
    connected: false,
  })),
}))

globalThis.fetch = (() => {
  throw new Error('unmocked fetch in a test — mock the endpoint')
}) as unknown as typeof fetch
