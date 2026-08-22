'use client'

import * as React from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WalletProvider, useWallet } from '@lolipay/wallet'
import { authenticate } from '@lolipay/api-client'
import { client } from '@/lib/client'
import { getDefaultKit } from '@/lib/wallet-kit'

type Kit = {
  openModal: (o: { onWalletSelected: (w: { id: string }) => void }) => Promise<void>
  setWallet: (id: string) => void
  getAddress: () => Promise<{ address: string }>
  signTransaction: (
    xdr: string,
    opts: { networkPassphrase: string },
  ) => Promise<{ signedTxXdr: string }>
  signMessage?: (
    message: string,
    opts?: { networkPassphrase?: string; address?: string },
  ) => Promise<{ signedMessage: string }>
}

type AuthCtx = {
  token: string | null

  address: string | null
  login: (address: string) => Promise<void>
  logout: () => void
}

const AuthContext = React.createContext<AuthCtx | null>(null)

function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = React.useState<string | null>(() =>
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('lp_jwt') : null,
  )
  const [address, setAddress] = React.useState<string | null>(() =>
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('lp_addr') : null,
  )

  const wallet = useWallet()

  const walletRef = React.useRef(wallet)
  walletRef.current = wallet

  const login = React.useCallback(async (address: string) => {
    if (!address) throw new Error('login: address is required — call connect() first')
    const w = walletRef.current
    await authenticate(client, address, w.signMessage)
    const t = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('lp_jwt') : null
    setToken(t)
    if (t) {
      if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('lp_addr', address)
      setAddress(address)
    }
  }, [])

  const logout = React.useCallback(() => {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem('lp_jwt')
      sessionStorage.removeItem('lp_addr')
    }
    setToken(null)
    setAddress(null)

    queryClient.clear()
  }, [])

  return (
    <AuthContext.Provider value={{ token, address, login, logout }}>{children}</AuthContext.Provider>
  )
}

export function useAuth(): AuthCtx {
  const c = React.useContext(AuthContext)
  if (!c) throw new Error('useAuth must be used within <Providers>')
  return c
}

export const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
})

export function Providers({
  children,
  kit,
}: {
  children: React.ReactNode
  kit?: Kit
}) {
  const resolvedKit = React.useRef<Kit | null>(null)
  if (resolvedKit.current === null) {
    resolvedKit.current = kit ?? getDefaultKit()
  } else if (kit !== undefined && resolvedKit.current !== kit) {
    resolvedKit.current = kit
  }

  return (
    <QueryClientProvider client={queryClient}>
      <WalletProvider kit={resolvedKit.current!}>
        <AuthProvider>{children}</AuthProvider>
      </WalletProvider>
    </QueryClientProvider>
  )
}
