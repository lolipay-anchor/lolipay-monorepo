import * as React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'

vi.mock('@/lib/wallet-kit', () => ({
  getDefaultKit: vi.fn(() => ({})),
}))

vi.mock('next/link', () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string
    children: React.ReactNode
    [key: string]: unknown
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}))

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/'),
  useRouter: vi.fn(() => ({ back: vi.fn() })),
}))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getNotifications: vi.fn(async () => ({ unread: 0 })),
  }
})

const { AppHeader } = await import('@/components/AppHeader')

function authed() {
  sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
  sessionStorage.setItem('lp_addr', 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X')
}

describe('AppHeader (LP)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    queryClient.clear()
  })

  it('renders the title only once (row 2) when showBack is false', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader title="Assignments" />
      </TestProviders>,
    )

    expect(screen.getAllByText('Assignments')).toHaveLength(1)
  })

  it('does NOT duplicate the title when showBack is true (title renders inline next to the back arrow only)', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader title="Order detail" showBack />
      </TestProviders>,
    )

    expect(screen.getAllByText('Order detail')).toHaveLength(1)

    expect(screen.getByLabelText('Go back')).toHaveTextContent('Order detail')
  })

  it('expands the back button hit area to ~40px without changing the visible glyph size', () => {
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader title="Order detail" showBack />
      </TestProviders>,
    )
    const back = screen.getByLabelText('Go back')
    expect(back.className).toContain('-m-2.5')
    expect(back.className).toContain('p-2.5')
  })

  it('the bell is a link to the notifications route, so there is no handler that could mark anything read', () => {
    authed()
    render(
      <TestProviders kit={fakeKit}>
        <AppHeader title="Dashboard" />
      </TestProviders>,
    )

    expect(screen.getByRole('link', { name: 'Notifications' })).toHaveAttribute('href', '/notifications')
  })
})
