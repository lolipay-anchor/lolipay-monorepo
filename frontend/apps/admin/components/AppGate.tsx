'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useWallet } from '@lolipay/wallet'
import { getAdminConfig } from '@lolipay/api-client'
import { useAuth } from '@/app/providers'
import { client } from '@/lib/client'
import { NavShell } from '@/app/nav-shell'
import { LoginScreen } from './LoginScreen'
import { NotAuthorized } from './NotAuthorized'

export function AppGate({ children }: { children: React.ReactNode }) {
  const { token, logout } = useAuth()
  const wallet = useWallet()
  const [hasMounted, setHasMounted] = React.useState(false)

  React.useEffect(() => {
    setHasMounted(true)
  }, [])

  const { data, isLoading, error } = useQuery({
    queryKey: ['adminConfig'],
    queryFn: () => getAdminConfig(client),
    enabled: !!token,
    retry: false,

    staleTime: 0,
  })

  if (!hasMounted) return null

  if (!token) return <LoginScreen />

  if (isLoading) return null

  if (data) {
    return (
      <>
        {children}
        <NavShell />
      </>
    )
  }

  if (error) {
    const handleDisconnect = () => {
      wallet.disconnect()
      logout()
    }
    return <NotAuthorized onDisconnect={handleDisconnect} />
  }

  return null
}
