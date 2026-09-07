import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { queryClient } from '@/app/providers'
import { AppGate } from '@/components/AppGate'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))

vi.mock('next/navigation', () => ({
  usePathname: vi.fn(() => '/'),
  useRouter: vi.fn(() => ({ back: vi.fn(), push: vi.fn() })),
}))

describe('a dead session returns the app to its login screen', () => {
  beforeEach(() => {
    sessionStorage.clear()
    queryClient.clear()
  })

  it('a 401 on the first request with a held token lands on the login screen with the sentence', async () => {
    sessionStorage.setItem('lp_jwt', 'dead-jwt')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) }))
    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="shell">SHELL</div>
        </AppGate>
      </TestProviders>,
    )
    await waitFor(() => {
      expect(screen.getByTestId('session-expired').textContent).toBe('Your session expired. Reconnect your wallet to continue.')
    })
    expect(screen.getByRole('button', { name: /connect wallet/i })).toBeTruthy()
    expect(screen.queryByTestId('shell')).toBeNull()
    expect(sessionStorage.getItem('lp_jwt') || null).toBeNull()
  })
})
