import * as React from 'react'

type Kit = {
  openModal: (o: { onWalletSelected: (w: { id: string }) => void }) => Promise<void>
  setWallet: (id: string) => void
  getAddress: () => Promise<{ address: string }>
  signTransaction: (xdr: string, opts: { networkPassphrase: string }) => Promise<{ signedTxXdr: string }>

  signMessage?: (
    message: string,
    opts?: { networkPassphrase?: string; address?: string },
  ) => Promise<{ signedMessage: string }>

  disconnect?: () => Promise<void>
}

type Ctx = {
  address: string | null
  connect: () => Promise<string>
  disconnect: () => void
  signTransaction: (xdr: string, np: string) => Promise<string>
  signMessage: (msg: string, address?: string) => Promise<string>
}

const WalletCtx = React.createContext<Ctx | null>(null)

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out — please try again`)),
      ms,
    )
  })
  return Promise.race([
    Promise.resolve(p).finally(() => clearTimeout(timer)),
    timeout,
  ])
}

export const WC_STALE_RE =
  /no matching key|session topic doesn't exist|missing or invalid.*topic|record was recently deleted/is

function isWcStaleError(e: unknown): boolean {
  const msg =
    e instanceof Error ? e.message : typeof e === 'string' ? e : ((e as any)?.message ?? String(e))
  return WC_STALE_RE.test(msg)
}

export async function clearWalletConnectSession(kit: Kit): Promise<void> {
  await kit.disconnect?.().catch(() => {})
  if (typeof localStorage === 'undefined') return

  const wcKeys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key && key.startsWith('wc@2:')) wcKeys.push(key)
  }
  for (const key of wcKeys) localStorage.removeItem(key)
}

const SESSION_EXPIRED_MESSAGE = 'Your wallet session expired — please reconnect your wallet.'

export function WalletProvider({ kit, children }: { kit: Kit; children: React.ReactNode }) {
  const [address, setAddress] = React.useState<string | null>(null)

  const attemptConnect = async (): Promise<string> => {
    await withTimeout(
      kit.openModal({ onWalletSelected: (w) => kit.setWallet(w.id) }),
      120_000,
      'Wallet connection',
    )
    const { address: addr } = await withTimeout(kit.getAddress(), 30_000, 'Reading wallet address')
    setAddress(addr)
    return addr
  }

  const connect = async (): Promise<string> => {
    try {
      return await attemptConnect()
    } catch (e) {
      if (!isWcStaleError(e)) throw e

      await clearWalletConnectSession(kit)
      return await attemptConnect()
    }
  }

  const disconnect = () => {
    void kit.disconnect?.().catch(() => {})
    setAddress(null)
  }

  const signTransaction = async (xdr: string, np: string) => {
    if (!np) throw new Error('networkPassphrase is required')
    try {
      return (
        await withTimeout(
          kit.signTransaction(xdr, { networkPassphrase: np }),
          120_000,
          'Transaction signing',
        )
      ).signedTxXdr
    } catch (e) {
      if (!isWcStaleError(e)) throw e

      await clearWalletConnectSession(kit)
      setAddress(null)
      throw new Error(SESSION_EXPIRED_MESSAGE)
    }
  }

  const signMessage = async (msg: string, addr?: string) => {
    if (!kit.signMessage) throw new Error('signMessage is not supported by the active wallet module')

    const signer = addr ?? address ?? undefined

    let res: { signedMessage: string } | undefined
    try {
      res = await withTimeout(
        kit.signMessage(msg, { address: signer }),
        60_000,
        'Waiting for you to approve the signature in your wallet',
      )
    } catch (e) {
      if (!isWcStaleError(e)) throw e

      await clearWalletConnectSession(kit)
      setAddress(null)
      throw new Error(SESSION_EXPIRED_MESSAGE)
    }

    if (!res || !res.signedMessage) {
      throw new Error('No signature received from your wallet — please try again')
    }
    return res.signedMessage
  }

  return (
    <WalletCtx.Provider value={{ address, connect, disconnect, signTransaction, signMessage }}>
      {children}
    </WalletCtx.Provider>
  )
}

export function useWallet() {
  const c = React.useContext(WalletCtx)
  if (!c) throw new Error('useWallet must be used within WalletProvider')
  return c
}
