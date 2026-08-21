import * as React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@lolipay/wallet', () => ({
  useWallet: () => ({
    address: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X',
    signTransaction: vi.fn(async () => 'SIGNED_XDR'),
  }),
}))

vi.mock('@/lib/trustline', () => ({
  checkUsdcTrustline: vi.fn(async () => 'missing'),
  buildChangeTrustXdr: vi.fn(async () => 'UNSIGNED_XDR'),
  networkPassphrase: 'Test SDF Network ; September 2015',
}))

const { TrustlineNotice } = await import('@/components/TrustlineNotice')

function renderWithClient() {
  const qc = new QueryClient()
  return render(
    <QueryClientProvider client={qc}>
      <TrustlineNotice />
    </QueryClientProvider>,
  )
}

describe('TrustlineNotice', () => {
  it('the "Enable USDC — sign" CTA has a >=44px-friendly tap target (py-3)', async () => {
    renderWithClient()
    const cta = await screen.findByTestId('add-trustline')
    expect(cta.className).toContain('py-3')
    expect(cta.className).not.toContain('py-1.5')
  })
})
