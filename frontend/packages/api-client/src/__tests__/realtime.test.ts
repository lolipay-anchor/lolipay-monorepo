import { describe, it, expect, vi, afterEach } from 'vitest'

const mockIo = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() })))
vi.mock('socket.io-client', () => ({ io: mockIo }))

import { connectRealtime } from '../realtime'

describe('connectRealtime', () => {
  afterEach(() => {
    mockIo.mockClear()
  })

  it('connects to `${baseUrl}/ws` with the token in the auth handshake payload', () => {
    connectRealtime({ baseUrl: 'https://api.lolipay.app', token: 'JWT123' })

    expect(mockIo).toHaveBeenCalledWith(
      'https://api.lolipay.app/ws',
      expect.objectContaining({ auth: { token: 'JWT123' } }),
    )
  })

  it('enables reconnection (socket.io default retry — the client-side half of the fallback contract)', () => {
    connectRealtime({ baseUrl: 'https://api.lolipay.app', token: 'JWT123' })

    expect(mockIo).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ reconnection: true }))
  })

  it('returns whatever `io()` returns (the Socket instance) — no wrapping/hiding of the API', () => {
    const fakeSocket = { on: vi.fn(), emit: vi.fn(), disconnect: vi.fn() }
    mockIo.mockReturnValueOnce(fakeSocket)

    const result = connectRealtime({ baseUrl: 'https://api.lolipay.app', token: 'JWT123' })

    expect(result).toBe(fakeSocket)
  })
})
