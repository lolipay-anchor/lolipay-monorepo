import * as React from 'react'
import { render, waitFor, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { makeFakeSocket, type FakeSocket } from './realtime-helpers'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))

let lastSocket: FakeSocket
const mockIo = vi.hoisted(() => vi.fn())
vi.mock('socket.io-client', () => ({ io: mockIo }))

const { useRealtimeChannel } = await import('@/hooks/useRealtimeChannel')
const { useAuth } = await import('@/app/providers')

function Harness(props: {
  orderIds?: string[]
  onOrderUpdate?: (p: { id: string; status: string; flow: string; updated_at: string }) => void
  onAssignmentsChanged?: (p: { orderId: string; status: string }) => void
}) {
  useRealtimeChannel(props)
  return null
}

function LogoutHarness(props: {
  onOrderUpdate?: (p: { id: string; status: string; flow: string; updated_at: string }) => void
}) {
  const { logout } = useAuth()
  useRealtimeChannel(props)
  return (
    <button type="button" data-testid="logout-btn" onClick={logout}>
      logout
    </button>
  )
}

function authed() {
  sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
  sessionStorage.setItem('lp_addr', 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X')
}

describe('useRealtimeChannel (admin)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mockIo.mockReset()
    lastSocket = makeFakeSocket()
    mockIo.mockImplementation(() => lastSocket)
  })

  it('does NOT connect when there is no auth token', () => {
    render(
      <TestProviders kit={fakeKit}>
        <Harness onOrderUpdate={vi.fn()} />
      </TestProviders>,
    )
    expect(mockIo).not.toHaveBeenCalled()
  })

  it('connects to `${baseUrl}/ws` with the JWT once authenticated', () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <Harness onOrderUpdate={vi.fn()} />
      </TestProviders>,
    )
    expect(mockIo).toHaveBeenCalledTimes(1)
    const [url, opts] = mockIo.mock.calls[0]
    expect(url).toMatch(/\/ws$/)
    expect((opts as { auth: { token: string } }).auth.token).toBe('fake-jwt-token')
  })

  it('joins every id in orderIds on connect — admin is authorized for any order', () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <Harness orderIds={['ord-a', 'ord-b']} onOrderUpdate={vi.fn()} />
      </TestProviders>,
    )
    lastSocket.__trigger('connect')
    expect(lastSocket.emit).toHaveBeenCalledWith('join:order', { orderId: 'ord-a' })
    expect(lastSocket.emit).toHaveBeenCalledWith('join:order', { orderId: 'ord-b' })
  })

  it('calls onOrderUpdate on order:update', () => {
    authed()
    const onOrderUpdate = vi.fn()
    render(
      <TestProviders kit={fakeKit}>
        <Harness orderIds={['ord-a']} onOrderUpdate={onOrderUpdate} />
      </TestProviders>,
    )
    const payload = { id: 'ord-a', status: 'RELEASED', flow: 'TOP_UP', updated_at: '2026-01-01T00:00:00Z' }
    lastSocket.__trigger('order:update', payload)
    expect(onOrderUpdate).toHaveBeenCalledWith(payload)
  })

  it('disconnects on unmount', () => {
    authed()
    const { unmount } = render(
      <TestProviders kit={fakeKit}>
        <Harness onOrderUpdate={vi.fn()} />
      </TestProviders>,
    )
    unmount()
    expect(lastSocket.disconnect).toHaveBeenCalledTimes(1)
  })

  it('disconnects the socket when the token transitions set→null (logout) mid-session, not just on unmount', () => {
    authed()
    const { getByTestId } = render(
      <TestProviders kit={fakeKit}>
        <LogoutHarness onOrderUpdate={vi.fn()} />
      </TestProviders>,
    )
    expect(mockIo).toHaveBeenCalledTimes(1)
    expect(lastSocket.disconnect).not.toHaveBeenCalled()

    fireEvent.click(getByTestId('logout-btn'))

    expect(lastSocket.disconnect).toHaveBeenCalledTimes(1)
  })

  it('never throws when the socket errors', async () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <Harness onOrderUpdate={vi.fn()} />
      </TestProviders>,
    )
    expect(() => lastSocket.__trigger('connect_error', new Error('unreachable'))).not.toThrow()
    await waitFor(() => expect(mockIo).toHaveBeenCalled())
  })
})
