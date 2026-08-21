import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
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
  usePathname: vi.fn(() => '/assignments'),
  useRouter: vi.fn(() => ({ back: vi.fn() })),
}))

let lastSocket: FakeSocket
const mockIo = vi.hoisted(() => vi.fn())
vi.mock('socket.io-client', () => ({ io: mockIo }))

const mockGetAssignments = vi.hoisted(() => vi.fn())
const mockGetNotifications = vi.hoisted(() => vi.fn(async () => ({ unread: 0 })))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getAssignments: mockGetAssignments,
    getNotifications: mockGetNotifications,
  }
})

const AssignmentsPage = (await import('@/app/assignments/page')).default

function authed() {
  sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
  sessionStorage.setItem('lp_addr', 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X')
}

describe('AssignmentsPage — realtime wiring', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mockIo.mockReset()
    mockGetAssignments.mockReset()
    lastSocket = makeFakeSocket()
    mockIo.mockImplementation(() => lastSocket)
  })

  it('refetches assignments when assignments:changed arrives', async () => {
    authed()
    mockGetAssignments.mockResolvedValue([])

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentsPage />
      </TestProviders>,
    )

    await waitFor(() => expect(mockGetAssignments).toHaveBeenCalled())
    mockGetAssignments.mockClear()

    lastSocket.__trigger('assignments:changed', { orderId: 'ord-1', status: 'REQUESTED' })

    await waitFor(() => expect(mockGetAssignments).toHaveBeenCalled())
  })

  it('still renders the empty state when the socket never connects (pure polling fallback)', async () => {
    authed()
    mockGetAssignments.mockResolvedValue([])

    render(
      <TestProviders kit={fakeKit}>
        <AssignmentsPage />
      </TestProviders>,
    )

    await waitFor(() => {
      expect(screen.getByText(/No assignments yet/i)).toBeTruthy()
    })
  })
})
