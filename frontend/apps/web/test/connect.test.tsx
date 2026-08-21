import * as React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { TestProviders, fakeKit } from './helpers'
import { ConnectGate } from '@/components/ConnectGate'

vi.mock('@/lib/wallet-kit', () => ({
  getDefaultKit: vi.fn(() => ({})),
}))

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@lolipay/api-client')>()
  return {
    ...actual,
    authenticate: vi.fn(
      async (
        _client: unknown,
        _address: string,
        signMessage: (m: string) => Promise<string>,
      ) => {
        await signMessage('test-nonce')
        sessionStorage.setItem('lp_jwt', 'fake-jwt-token')
      },
    ),
  }
})

describe('ConnectGate', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.clearAllMocks()

    fakeKit.openModal.mockImplementation(
      async ({ onWalletSelected }: { onWalletSelected: (w: { id: string }) => void }) => {
        onWalletSelected({ id: 'freighter' })
      },
    )
    fakeKit.getAddress.mockResolvedValue({ address: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X' })
    fakeKit.signMessage.mockResolvedValue({ signedMessage: btoa('fake-signature') })
  })

  it('hides children when not authenticated', () => {
    render(
      <TestProviders kit={fakeKit}>
        <ConnectGate>
          <div>SECRET</div>
        </ConnectGate>
      </TestProviders>,
    )
    expect(screen.queryByText('SECRET')).toBeNull()
    expect(screen.getByText('Connect Wallet')).toBeTruthy()
  })

  it('shows children after connecting and authenticating', async () => {
    render(
      <TestProviders kit={fakeKit}>
        <ConnectGate>
          <div>SECRET</div>
        </ConnectGate>
      </TestProviders>,
    )

    expect(screen.queryByText('SECRET')).toBeNull()

    fireEvent.click(screen.getByText('Connect Wallet'))

    await waitFor(() => {
      expect(screen.getByText('SECRET')).toBeTruthy()
    })
    expect(screen.queryByText('Connect Wallet')).toBeNull()
  })

  it('skips wallet.connect() when address is already set', async () => {
    const { unmount } = render(
      <TestProviders kit={fakeKit}>
        <ConnectGate>
          <div>SECRET</div>
        </ConnectGate>
      </TestProviders>,
    )
    fireEvent.click(screen.getByText('Connect Wallet'))
    await waitFor(() => screen.getByText('SECRET'))
    unmount()

    render(
      <TestProviders kit={fakeKit}>
        <ConnectGate>
          <div>SECRET</div>
        </ConnectGate>
      </TestProviders>,
    )
    expect(screen.getByText('SECRET')).toBeTruthy()
  })
})
