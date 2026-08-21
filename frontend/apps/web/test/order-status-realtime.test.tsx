import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { makeFakeSocket, type FakeSocket } from './realtime-helpers'
import type { Order } from '@lolipay/api-client'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: { href: string; children: React.ReactNode; [k: string]: unknown }) => (
    <a href={href} {...props}>{children}</a>
  ),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}))

let lastSocket: FakeSocket
const mockIo = vi.hoisted(() => vi.fn())
vi.mock('socket.io-client', () => ({ io: mockIo }))

const mockGetOrder = vi.hoisted(() => vi.fn())
const mockGetNotifications = vi.hoisted(() => vi.fn(async () => ({ unread: 0 })))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getOrder: mockGetOrder,
    getNotifications: mockGetNotifications,
  }
})

const { OrderStatus } = await import('@/components/OrderStatus')
const { NotificationBell } = await import('@/components/NotificationBell')

const BASE_ORDER: Order = {
  id: 'ord-rt-1',
  trade_id: 'tr-1',
  user_address: 'GDXXX',
  lp_wallet: 'GDYYY',
  flow: 'TOP_UP',
  rail: 'BANK',
  usdc_amount: '1000000000',
  fiat_amount: '1600000',
  fiat_currency: 'IDR',
  rate_snapshot: '16000',
  platform_fee_bps: 30,
  lp_fee_bps: 120,
  status: 'FUNDED',
  pay_deadline: Math.floor(Date.now() / 1000) + 3600,
  confirm_deadline: Math.floor(Date.now() / 1000) + 7200,
  dispute_deadline: Math.floor(Date.now() / 1000) + 86400,
  expires_at: new Date(Date.now() + 3600000).toISOString(),
  created_at: new Date().toISOString(),
}

function authed() {
  sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
  sessionStorage.setItem('lp_addr', 'GDXXX')
}

describe('OrderStatus — realtime wiring', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mockIo.mockReset()
    mockGetOrder.mockReset()
    lastSocket = makeFakeSocket()
    mockIo.mockImplementation(() => lastSocket)
  })

  it('joins order:{id} on connect', async () => {
    authed()
    mockGetOrder.mockResolvedValue(BASE_ORDER)
    render(
      <TestProviders kit={fakeKit}>
        <OrderStatus id="ord-rt-1" />
      </TestProviders>,
    )
    await waitFor(() => expect(mockGetOrder).toHaveBeenCalled())
    lastSocket.__trigger('connect')
    expect(lastSocket.emit).toHaveBeenCalledWith('join:order', { orderId: 'ord-rt-1' })
  })

  it('refetches the order when order:update arrives for THIS order id (e.g. an admin dispute resolution)', async () => {
    authed()
    mockGetOrder.mockResolvedValueOnce(BASE_ORDER)
    render(
      <TestProviders kit={fakeKit}>
        <OrderStatus id="ord-rt-1" />
      </TestProviders>,
    )
    await waitFor(() => expect(screen.getAllByText(/USDC/).length).toBeGreaterThan(0))

    const resolved = { ...BASE_ORDER, status: 'RELEASED' as const }
    mockGetOrder.mockResolvedValueOnce(resolved)
    mockGetOrder.mockClear()

    lastSocket.__trigger('order:update', {
      id: 'ord-rt-1',
      status: 'RELEASED',
      flow: 'TOP_UP',
      updated_at: new Date().toISOString(),
    })

    await waitFor(() => expect(mockGetOrder).toHaveBeenCalled())
  })

  it('ignores an order:update for a DIFFERENT order id — no refetch', async () => {
    authed()
    mockGetOrder.mockResolvedValueOnce(BASE_ORDER)
    render(
      <TestProviders kit={fakeKit}>
        <OrderStatus id="ord-rt-1" />
      </TestProviders>,
    )
    await waitFor(() => expect(mockGetOrder).toHaveBeenCalled())
    mockGetOrder.mockClear()

    lastSocket.__trigger('order:update', {
      id: 'some-other-order',
      status: 'RELEASED',
      flow: 'TOP_UP',
      updated_at: new Date().toISOString(),
    })

    await new Promise((r) => setTimeout(r, 10))
    expect(mockGetOrder).not.toHaveBeenCalled()
  })

  it('disconnects the order-status socket on unmount', async () => {
    authed()
    mockGetOrder.mockResolvedValue(BASE_ORDER)
    const { unmount } = render(
      <TestProviders kit={fakeKit}>
        <OrderStatus id="ord-rt-1" />
      </TestProviders>,
    )
    await waitFor(() => expect(mockGetOrder).toHaveBeenCalled())
    unmount()
    expect(lastSocket.disconnect).toHaveBeenCalledTimes(1)
  })

  it('still renders and keeps polling when the socket errors immediately', async () => {
    authed()
    mockGetOrder.mockResolvedValue(BASE_ORDER)
    render(
      <TestProviders kit={fakeKit}>
        <OrderStatus id="ord-rt-1" />
      </TestProviders>,
    )
    await waitFor(() => expect(mockGetOrder).toHaveBeenCalled())
    expect(() => lastSocket.__trigger('connect_error', new Error('unreachable'))).not.toThrow()
    expect(screen.queryByText(/Failed to load/i)).toBeNull()
  })
})

describe('NotificationBell — global realtime wiring', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mockIo.mockReset()
    mockGetNotifications.mockReset().mockResolvedValue({ unread: 0 })
    lastSocket = makeFakeSocket()
    mockIo.mockImplementation(() => lastSocket)
  })

  it('connects without joining any order room (server auto-joins user:{address})', async () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <NotificationBell />
      </TestProviders>,
    )
    await waitFor(() => expect(mockGetNotifications).toHaveBeenCalled())
    lastSocket.__trigger('connect')
    expect(lastSocket.emit).not.toHaveBeenCalled()
  })

  it('refetches the unread count when any order:update arrives', async () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <NotificationBell />
      </TestProviders>,
    )
    await waitFor(() => expect(mockGetNotifications).toHaveBeenCalled())
    mockGetNotifications.mockClear()

    lastSocket.__trigger('order:update', {
      id: 'any-order',
      status: 'RELEASED',
      flow: 'TOP_UP',
      updated_at: new Date().toISOString(),
    })

    await waitFor(() => expect(mockGetNotifications).toHaveBeenCalled())
  })
})
