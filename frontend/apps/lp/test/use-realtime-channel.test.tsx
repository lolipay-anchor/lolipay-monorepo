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
  onAssignmentsChanged?: (p: { orderId: string; status: string }) => void
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

describe('useRealtimeChannel (LP)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mockIo.mockReset()
    lastSocket = makeFakeSocket()
    mockIo.mockImplementation(() => lastSocket)
  })

  it('does NOT connect when there is no auth token', () => {
    render(
      <TestProviders kit={fakeKit}>
        <Harness onAssignmentsChanged={vi.fn()} />
      </TestProviders>,
    )
    expect(mockIo).not.toHaveBeenCalled()
  })

  it('connects to `${baseUrl}/ws` with the JWT once authenticated', () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <Harness onAssignmentsChanged={vi.fn()} />
      </TestProviders>,
    )
    expect(mockIo).toHaveBeenCalledTimes(1)
    const [url, opts] = mockIo.mock.calls[0]
    expect(url).toMatch(/\/ws$/)
    expect((opts as { auth: { token: string } }).auth.token).toBe('fake-jwt-token')
  })

  it('calls onAssignmentsChanged with the payload — no explicit join needed (lp:assignments auto-joined server-side)', () => {
    authed()
    const onAssignmentsChanged = vi.fn()
    render(
      <TestProviders kit={fakeKit}>
        <Harness onAssignmentsChanged={onAssignmentsChanged} />
      </TestProviders>,
    )
    lastSocket.__trigger('connect')
    expect(lastSocket.emit).not.toHaveBeenCalled()

    const payload = { orderId: 'ord-9', status: 'REQUESTED' }
    lastSocket.__trigger('assignments:changed', payload)
    expect(onAssignmentsChanged).toHaveBeenCalledWith(payload)
  })

  it('disconnects the socket on unmount', () => {
    authed()
    const { unmount } = render(
      <TestProviders kit={fakeKit}>
        <Harness onAssignmentsChanged={vi.fn()} />
      </TestProviders>,
    )
    unmount()
    expect(lastSocket.disconnect).toHaveBeenCalledTimes(1)
  })

  it('disconnects the socket when the token transitions set→null (logout) mid-session, not just on unmount', () => {
    authed()
    const { getByTestId } = render(
      <TestProviders kit={fakeKit}>
        <LogoutHarness onAssignmentsChanged={vi.fn()} />
      </TestProviders>,
    )
    expect(mockIo).toHaveBeenCalledTimes(1)
    expect(lastSocket.disconnect).not.toHaveBeenCalled()

    fireEvent.click(getByTestId('logout-btn'))

    expect(lastSocket.disconnect).toHaveBeenCalledTimes(1)
  })

  it('never throws when the socket errors — polling stays the fallback', async () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <Harness onAssignmentsChanged={vi.fn()} />
      </TestProviders>,
    )
    expect(() => lastSocket.__trigger('connect_error', new Error('unreachable'))).not.toThrow()
    await waitFor(() => expect(mockIo).toHaveBeenCalled())
  })
})
