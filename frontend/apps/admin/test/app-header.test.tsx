import * as React from 'react'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { TestProviders, fakeKit } from './helpers'

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

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    getNotifications: async () => ({ unread: 0 }),
    markNotificationsRead: async () => ({}),
  }
})

const { AppHeader } = await import('@/components/AppHeader')

describe('AppHeader (admin)', () => {
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
})
