import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TestProviders } from './helpers'
import { useAuth, queryClient } from '@/app/providers'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))
vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/'),
  useRouter: vi.fn(() => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() })),
}))

function LogoutButton() {
  const { logout } = useAuth()
  return (
    <button data-testid="logout" onClick={() => logout()}>
      log out
    </button>
  )
}

describe('logout clears the React Query cache (INV-19.9)', () => {
  beforeEach(() => {
    sessionStorage.clear()
    queryClient.clear()
  })

  it('leaves no cached data from the previous account behind', async () => {
    sessionStorage.setItem('lp_jwt', 'a-token')
    sessionStorage.setItem('lp_addr', 'GPREVIOUSACCOUNT')
    queryClient.setQueryData(['orders'], [{ id: 'previous-account-order' }])
    expect(queryClient.getQueryData(['orders'])).toBeTruthy()

    render(
      <TestProviders>
        <LogoutButton />
      </TestProviders>,
    )

    screen.getByTestId('logout').click()

    await waitFor(() => {
      expect(queryClient.getQueryData(['orders'])).toBeUndefined()
    })
    expect(sessionStorage.getItem('lp_jwt')).toBeNull()
    expect(sessionStorage.getItem('lp_addr')).toBeNull()
  })
})
