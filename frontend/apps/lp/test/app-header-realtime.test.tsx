import * as React from 'react'
import { render, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { makeFakeSocket, type FakeSocket } from './realtime-helpers'

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
  useRouter: vi.fn(() => ({ back: vi.fn(), replace: vi.fn() })),
  usePathname: vi.fn(() => '/'),
}))

let lastSocket: FakeSocket
const mockIo = vi.hoisted(() => vi.fn())
vi.mock('socket.io-client', () => ({ io: mockIo }))

const mockGetNotifications = vi.hoisted(() => vi.fn(async () => ({ unread: 0 })))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getNotifications: mockGetNotifications,
    markNotificationsRead: vi.fn(async () => ({})),
  }
})

const { AppHeader } = await import('@/components/AppHeader')

function authed() {
  sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
  sessionStorage.setItem('lp_addr', 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X')
}

describe('AppHeader (LP) — global realtime wiring', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mockIo.mockReset()
    mockGetNotifications.mockReset().mockResolvedValue({ unread: 0 })
    lastSocket = makeFakeSocket()
    mockIo.mockImplementation(() => lastSocket)
  })

  it('refetches the unread count when any order:update arrives', async () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader />
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

  it('never connects when logged out', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader />
      </TestProviders>,
    )
    expect(mockIo).not.toHaveBeenCalled()
  })
})
