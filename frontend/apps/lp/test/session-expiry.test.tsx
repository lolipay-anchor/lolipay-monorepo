import * as React from 'react'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
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

  it('drops the expiry sentence the moment the login screen has an error of its own', async () => {
    sessionStorage.setItem('lp_expired', '1')
    fakeKit.openModal.mockRejectedValueOnce(new Error('User rejected connection'))
    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="shell">SHELL</div>
        </AppGate>
      </TestProviders>,
    )
    expect(await screen.findByTestId('session-expired')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /connect wallet/i }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('User rejected connection')
    expect(screen.queryByTestId('session-expired')).toBeNull()
  })

  it('forgets the expiry flag once a login succeeds, so a later disconnect does not claim the session expired', async () => {
    sessionStorage.setItem('lp_expired', '1')
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/auth/challenge')) return { ok: true, status: 201, json: async () => ({ nonce: 'nonce-1' }) }
      if (url.endsWith('/auth/verify')) return { ok: true, status: 201, json: async () => ({ jwt: 'fresh-jwt' }) }
      return { ok: false, status: 500, json: async () => ({ message: 'not part of this test' }) }
    }))
    render(
      <TestProviders kit={fakeKit}>
        <AppGate>
          <div data-testid="shell">SHELL</div>
        </AppGate>
      </TestProviders>,
    )
    fireEvent.click(await screen.findByRole('button', { name: /connect wallet/i }))
    await waitFor(() => {
      expect(sessionStorage.getItem('lp_jwt')).toBe('fresh-jwt')
    })
    expect(sessionStorage.getItem('lp_expired')).toBeNull()
  })

  it('a pending applicant whose session dies mid-poll lands on the login screen with the sentence, not on a frozen pending screen', async () => {
    sessionStorage.setItem('lp_jwt', 'pending-jwt')
    const pending = {
      id: 'lp-1',
      stellarAddress: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X',
      status: 'PENDING',
      contact: 'lp@example.com',
      liquidityProof: 'https://example.com/proof',
      approvalNote: null,
      online: false,
      lastHeartbeatAt: null,
      createdAt: '2026-09-07T00:00:00.000Z',
      approvedAt: null,
      paymentMethods: [],
    }
    let profileReads = 0
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/lp/me') && profileReads === 0) {
        profileReads += 1
        return { ok: true, status: 200, json: async () => pending }
      }
      return { ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) }
    }))
    vi.useFakeTimers()
    try {
      render(
        <TestProviders kit={fakeKit}>
          <AppGate>
            <div data-testid="shell">SHELL</div>
          </AppGate>
        </TestProviders>,
      )
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100)
      })
      expect(screen.getByText(/Application under review/i)).toBeTruthy()
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
      expect(screen.getByTestId('session-expired').textContent).toBe('Your session expired. Reconnect your wallet to continue.')
      expect(screen.queryByText(/Application under review/i)).toBeNull()
      expect(sessionStorage.getItem('lp_jwt') || null).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})
