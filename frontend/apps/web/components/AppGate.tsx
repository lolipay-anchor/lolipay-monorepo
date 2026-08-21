'use client'

import * as React from 'react'
import { useAuth } from '@/app/providers'
import { NavShell } from '@/app/nav-shell'
import { LoginScreen } from './LoginScreen'

export function AppGate({ children }: { children: React.ReactNode }) {
  const { token } = useAuth()
  const [hasMounted, setHasMounted] = React.useState(false)

  React.useEffect(() => {
    setHasMounted(true)
  }, [])

  if (!hasMounted) return null

  if (!token) return <LoginScreen />

  return (
    <>
      {children}
      <NavShell />
    </>
  )
}
