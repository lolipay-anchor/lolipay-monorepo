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

describe('useRealtimeChannel', () => {
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

  it('emits join:order for every id in orderIds on connect (and again on reconnect)', () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <Harness orderIds={['ord-1', 'ord-2']} onOrderUpdate={vi.fn()} />
      </TestProviders>,
    )
    lastSocket.__trigger('connect')
    expect(lastSocket.emit).toHaveBeenCalledWith('join:order', { orderId: 'ord-1' })
    expect(lastSocket.emit).toHaveBeenCalledWith('join:order', { orderId: 'ord-2' })

    lastSocket.emit.mockClear()
    lastSocket.__trigger('connect')
    expect(lastSocket.emit).toHaveBeenCalledWith('join:order', { orderId: 'ord-1' })
  })

  it('never emits join:order when no orderIds are given (e.g. the global notification listener)', () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <Harness onOrderUpdate={vi.fn()} />
      </TestProviders>,
    )
    lastSocket.__trigger('connect')
    expect(lastSocket.emit).not.toHaveBeenCalled()
  })

  it('calls onOrderUpdate with the payload on order:update', () => {
    authed()
    const onOrderUpdate = vi.fn()
    render(
      <TestProviders kit={fakeKit}>
        <Harness orderIds={['ord-1']} onOrderUpdate={onOrderUpdate} />
      </TestProviders>,
    )
    const payload = { id: 'ord-1', status: 'RELEASED', flow: 'TOP_UP', updated_at: '2026-01-01T00:00:00Z' }
    lastSocket.__trigger('order:update', payload)
    expect(onOrderUpdate).toHaveBeenCalledWith(payload)
  })

  it('calls onAssignmentsChanged with the payload on assignments:changed', () => {
    authed()
    const onAssignmentsChanged = vi.fn()
    render(
      <TestProviders kit={fakeKit}>
        <Harness onAssignmentsChanged={onAssignmentsChanged} />
      </TestProviders>,
    )
    const payload = { orderId: 'ord-9', status: 'FUNDED' }
    lastSocket.__trigger('assignments:changed', payload)
    expect(onAssignmentsChanged).toHaveBeenCalledWith(payload)
  })

  it('disconnects the socket on unmount', () => {
    authed()
    const { unmount } = render(
      <TestProviders kit={fakeKit}>
        <Harness onOrderUpdate={vi.fn()} />
      </TestProviders>,
    )
    unmount()
    expect(lastSocket.disconnect).toHaveBeenCalledTimes(1)
  })

  it('never throws when the socket errors — the caller keeps rendering (polling fallback)', async () => {
    authed()
    let threw = false
    try {
      render(
        <TestProviders kit={fakeKit}>
          <Harness onOrderUpdate={vi.fn()} />
        </TestProviders>,
      )
      lastSocket.__trigger('connect_error', new Error('unreachable'))
      lastSocket.__trigger('error', new Error('boom'))
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    await waitFor(() => expect(mockIo).toHaveBeenCalled())
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

  it('never throws even if connectRealtime/io() itself throws synchronously (e.g. misconfigured URL)', () => {
    authed()
    mockIo.mockImplementationOnce(() => {
      throw new Error('io() blew up')
    })
    expect(() =>
      render(
        <TestProviders kit={fakeKit}>
          <Harness onOrderUpdate={vi.fn()} />
        </TestProviders>,
      ),
    ).not.toThrow()
  })
})
