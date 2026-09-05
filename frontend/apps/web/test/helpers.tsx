import * as React from 'react'
import { ToastProvider } from '@/components/Toast'
import { vi } from 'vitest'
import { Providers } from '@/app/providers'

export const fakeKit = {
  openModal: vi.fn(async ({ onWalletSelected }: { onWalletSelected: (w: { id: string }) => void }) => {
    onWalletSelected({ id: 'freighter' })
  }),
  setWallet: vi.fn(),
  getAddress: vi.fn(async () => ({ address: 'GDCPLKM7CKTQSH7VM4BV3XXTYJB9SC6X' })),
  signTransaction: vi.fn(async () => ({ signedTxXdr: 'SIGNED_XDR' })),
  signMessage: vi.fn(async () => ({ signedMessage: btoa('fake-signature') })),
}

export function TestProviders({
  children,
  kit = fakeKit as any,
}: {
  children: React.ReactNode
  kit?: typeof fakeKit
}) {
  return (
    <ToastProvider>
      <Providers kit={kit}>{children}</Providers>
    </ToastProvider>
  )
}
