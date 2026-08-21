import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { WalletProvider, useWallet, clearWalletConnectSession, WC_STALE_RE } from '../index'

const staleWcError = () =>
  new Error("No matching key. session topic doesn't exist: abc123def")

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'

const fakeKit = {
  openModal: vi.fn(async ({ onWalletSelected }: any) => onWalletSelected({ id: 'freighter' })),
  setWallet: vi.fn(),
  getAddress: vi.fn(async () => ({ address: 'GDCPLKM7CKTQ...SC6X' })),
  signTransaction: vi.fn(async () => ({ signedTxXdr: 'SIGNED_XDR' })),
  signMessage: vi.fn(async () => ({ signedMessage: 'SIGNED_MSG' })),
}

function Probe() {
  const w = useWallet()
  return (
    <div>
      <button onClick={() => w.connect()}>connect</button>
      <span>{w.address ?? 'none'}</span>
    </div>
  )
}

function SignProbe() {
  const w = useWallet()
  const [result, setResult] = React.useState<string>('')
  return (
    <div>
      <button onClick={() => w.signTransaction('XDR', TESTNET_PASSPHRASE).then(setResult)}>
        signTx
      </button>
      <button onClick={() => w.signMessage('MSG').then(setResult)}>signMsg</button>
      <span data-testid="result">{result}</span>
    </div>
  )
}

import * as React from 'react'

describe('wallet', () => {
  it('connects and exposes the address', async () => {
    render(<WalletProvider kit={fakeKit as any}><Probe /></WalletProvider>)
    expect(screen.getByText('none')).toBeTruthy()
    fireEvent.click(screen.getByText('connect'))
    await waitFor(() => expect(screen.getByText('GDCPLKM7CKTQ...SC6X')).toBeTruthy())
  })

  it('connect() returns the fetched address', async () => {
    let returned: string | undefined
    function ReturnProbe() {
      const w = useWallet()
      return (
        <button onClick={async () => { returned = await w.connect() }}>connectReturn</button>
      )
    }
    render(<WalletProvider kit={fakeKit as any}><ReturnProbe /></WalletProvider>)
    fireEvent.click(screen.getByText('connectReturn'))
    await waitFor(() => expect(returned).toBe('GDCPLKM7CKTQ...SC6X'))
  })

  it('signTransaction returns the signed XDR string', async () => {
    render(<WalletProvider kit={fakeKit as any}><SignProbe /></WalletProvider>)
    fireEvent.click(screen.getByText('signTx'))
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('SIGNED_XDR'))
  })

  it('signMessage returns the signed message string', async () => {
    render(<WalletProvider kit={fakeKit as any}><SignProbe /></WalletProvider>)
    fireEvent.click(screen.getByText('signMsg'))
    await waitFor(() => expect(screen.getByTestId('result').textContent).toBe('SIGNED_MSG'))
  })

  it('signMessage forwards the address to pin the signing account', async () => {
    const kit = { ...fakeKit, signMessage: vi.fn(async () => ({ signedMessage: 'S' })) }
    function AddrProbe() {
      const w = useWallet()
      return <button onClick={() => w.signMessage('MSG', 'GXYZ')}>signAddr</button>
    }
    render(<WalletProvider kit={kit as any}><AddrProbe /></WalletProvider>)
    fireEvent.click(screen.getByText('signAddr'))
    await waitFor(() =>
      expect(kit.signMessage).toHaveBeenCalledWith('MSG', { address: 'GXYZ' }),
    )
  })

  it('signMessage throws a clear error when the wallet returns no signature', async () => {
    const kit = { ...fakeKit, signMessage: vi.fn(async () => ({ signedMessage: '' })) }
    let msg = ''
    function EmptyProbe() {
      const w = useWallet()
      return (
        <button onClick={() => w.signMessage('MSG').catch((e: Error) => (msg = e.message))}>
          signEmpty
        </button>
      )
    }
    render(<WalletProvider kit={kit as any}><EmptyProbe /></WalletProvider>)
    fireEvent.click(screen.getByText('signEmpty'))
    await waitFor(() => expect(msg).toMatch(/no signature/i))
  })

  it('disconnect tears down the kit and clears the address', async () => {
    const kit = { ...fakeKit, disconnect: vi.fn(async () => {}) }
    function DiscProbe() {
      const w = useWallet()
      return (
        <div>
          <button onClick={() => w.connect()}>connect</button>
          <button onClick={() => w.disconnect()}>disconnect</button>
          <span>{w.address ?? 'none'}</span>
        </div>
      )
    }
    render(<WalletProvider kit={kit as any}><DiscProbe /></WalletProvider>)
    fireEvent.click(screen.getByText('connect'))
    await waitFor(() => expect(screen.getByText('GDCPLKM7CKTQ...SC6X')).toBeTruthy())
    fireEvent.click(screen.getByText('disconnect'))

    await waitFor(() => expect(screen.getByText('none')).toBeTruthy())
    expect(kit.disconnect).toHaveBeenCalledTimes(1)
  })

  it('disconnect works even when the kit has no disconnect (test fakes)', async () => {
    function DiscProbe() {
      const w = useWallet()
      return (
        <div>
          <button onClick={() => w.connect()}>connect</button>
          <button onClick={() => w.disconnect()}>disconnect</button>
          <span>{w.address ?? 'none'}</span>
        </div>
      )
    }
    render(<WalletProvider kit={fakeKit as any}><DiscProbe /></WalletProvider>)
    fireEvent.click(screen.getByText('connect'))
    await waitFor(() => expect(screen.getByText('GDCPLKM7CKTQ...SC6X')).toBeTruthy())
    expect(() => fireEvent.click(screen.getByText('disconnect'))).not.toThrow()
    await waitFor(() => expect(screen.getByText('none')).toBeTruthy())
  })

  it('signTransaction rejects when networkPassphrase is empty', async () => {
    render(<WalletProvider kit={fakeKit as any}><SignProbe /></WalletProvider>)
    const { result: ctx } = { result: null } as any

    let threw = false
    const wrapper = render(
      <WalletProvider kit={fakeKit as any}>
        <GuardProbe onResult={(e) => { threw = e }} />
      </WalletProvider>,
    )
    fireEvent.click(wrapper.getByText('guardTest'))
    await waitFor(() => expect(threw).toBe(true))
  })
})

function GuardProbe({ onResult }: { onResult: (threw: boolean) => void }) {
  const w = useWallet()
  return (
    <button
      onClick={() =>
        w.signTransaction('XDR', '').then(() => onResult(false)).catch(() => onResult(true))
      }
    >
      guardTest
    </button>
  )
}

describe('WC_STALE_RE', () => {
  it('matches the known stale-WalletConnect-session rejection shapes', () => {
    expect(WC_STALE_RE.test("No matching key. session topic doesn't exist: abc")).toBe(true)
    expect(WC_STALE_RE.test('Session topic doesn\'t exist: abc')).toBe(true)
    expect(WC_STALE_RE.test('Missing or invalid. Record was recently deleted')).toBe(true)
    expect(WC_STALE_RE.test('User rejected the request')).toBe(false)
    expect(WC_STALE_RE.test('Waiting for you to approve the signature timed out — please try again')).toBe(
      false,
    )
  })

  it('matches across a multi-line message ("missing or invalid" ... "topic" on separate lines)', () => {
    expect(WC_STALE_RE.test('Missing or invalid.\nsession topic: abc')).toBe(true)
  })
})

describe('isWcStaleError (via signMessage) — plain-object error shape', () => {
  it('detects a plain object error carrying a .message, not just Error instances', async () => {
    const kit = {
      ...fakeKit,
      signMessage: vi.fn(async () => {
        // eslint-disable-next-line no-throw-literal
        throw { message: "No matching key. session topic doesn't exist: abc" }
      }),
      disconnect: vi.fn(async () => {}),
    }
    let caught: Error | null = null
    function PlainErrProbe() {
      const w = useWallet()
      return (
        <button onClick={() => w.signMessage('MSG').catch((e: Error) => (caught = e))}>
          signPlainErr
        </button>
      )
    }
    render(<WalletProvider kit={kit as any}><PlainErrProbe /></WalletProvider>)
    fireEvent.click(screen.getByText('signPlainErr'))

    await waitFor(() => expect(caught).not.toBeNull())

    expect(kit.disconnect).toHaveBeenCalledTimes(1)
    expect((caught as unknown as Error).message).toMatch(/session expired.*reconnect/i)
  })
})

describe('clearWalletConnectSession', () => {
  beforeEach(() => localStorage.clear())

  it('disconnects the kit and purges only wc@2:-prefixed keys', async () => {
    localStorage.setItem('wc@2:core/pairing//1', 'a')
    localStorage.setItem('wc@2:client//session', 'b')
    localStorage.setItem('lp_jwt', 'keep-me')
    localStorage.setItem('some-other-app-key', 'keep-me-too')
    const kit = { disconnect: vi.fn(async () => {}) } as any

    await clearWalletConnectSession(kit)

    expect(kit.disconnect).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('wc@2:core/pairing//1')).toBeNull()
    expect(localStorage.getItem('wc@2:client//session')).toBeNull()
    expect(localStorage.getItem('lp_jwt')).toBe('keep-me')
    expect(localStorage.getItem('some-other-app-key')).toBe('keep-me-too')
  })

  it('does not throw when the kit has no disconnect (test fakes)', async () => {
    localStorage.setItem('wc@2:x', '1')
    await expect(clearWalletConnectSession({} as any)).resolves.toBeUndefined()
    expect(localStorage.getItem('wc@2:x')).toBeNull()
  })
})

describe('stale WalletConnect session recovery', () => {
  beforeEach(() => localStorage.clear())

  it('signMessage: clears the session and throws a friendly, retryable error', async () => {
    localStorage.setItem('wc@2:client//session', 'dead')
    localStorage.setItem('lp_jwt', 'keep-me')
    const kit = {
      ...fakeKit,
      signMessage: vi.fn(async () => {
        throw staleWcError()
      }),
      disconnect: vi.fn(async () => {}),
    }
    let caught: Error | null = null
    function Probe2() {
      const w = useWallet()
      return (
        <button onClick={() => w.signMessage('MSG').catch((e: Error) => (caught = e))}>
          signStale
        </button>
      )
    }
    render(<WalletProvider kit={kit as any}><Probe2 /></WalletProvider>)
    fireEvent.click(screen.getByText('signStale'))

    await waitFor(() => expect(caught).not.toBeNull())
    expect(kit.disconnect).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem('wc@2:client//session')).toBeNull()
    expect(localStorage.getItem('lp_jwt')).toBe('keep-me')
    expect((caught as unknown as Error).message).toMatch(/session expired.*reconnect/i)
    expect((caught as unknown as Error).message).not.toMatch(/no matching key/i)
  })

  it('signTransaction: clears the session and throws a friendly, retryable error', async () => {
    const kit = {
      ...fakeKit,
      signTransaction: vi.fn(async () => {
        throw staleWcError()
      }),
      disconnect: vi.fn(async () => {}),
    }
    let caught: Error | null = null
    function Probe3() {
      const w = useWallet()
      const TESTNET = 'Test SDF Network ; September 2015'
      return (
        <button onClick={() => w.signTransaction('XDR', TESTNET).catch((e: Error) => (caught = e))}>
          signTxStale
        </button>
      )
    }
    render(<WalletProvider kit={kit as any}><Probe3 /></WalletProvider>)
    fireEvent.click(screen.getByText('signTxStale'))

    await waitFor(() => expect(caught).not.toBeNull())
    expect(kit.disconnect).toHaveBeenCalledTimes(1)
    expect((caught as unknown as Error).message).toMatch(/session expired.*reconnect/i)
  })

  it('connect: auto-recovers by clearing the session and retrying once', async () => {
    let getAddressCalls = 0
    const kit = {
      ...fakeKit,
      getAddress: vi.fn(async () => {
        getAddressCalls++
        if (getAddressCalls === 1) throw staleWcError()
        return { address: 'GRECOVERED' }
      }),
      disconnect: vi.fn(async () => {}),
    }
    render(<WalletProvider kit={kit as any}><Probe /></WalletProvider>)
    fireEvent.click(screen.getByText('connect'))

    await waitFor(() => expect(screen.getByText('GRECOVERED')).toBeTruthy())
    expect(getAddressCalls).toBe(2)
    expect(kit.disconnect).toHaveBeenCalledTimes(1)
  })

  it('connect: rethrows after a single retry when the stale error persists (no infinite loop)', async () => {
    let getAddressCalls = 0
    const kit = {
      ...fakeKit,
      getAddress: vi.fn(async () => {
        getAddressCalls++
        throw staleWcError()
      }),
      disconnect: vi.fn(async () => {}),
    }
    let caught: Error | null = null
    function ConnectCatchProbe() {
      const w = useWallet()
      return <button onClick={() => w.connect().catch((e: Error) => (caught = e))}>connectFail</button>
    }
    render(<WalletProvider kit={kit as any}><ConnectCatchProbe /></WalletProvider>)
    fireEvent.click(screen.getByText('connectFail'))

    await waitFor(() => expect(caught).not.toBeNull())
    expect(getAddressCalls).toBe(2)
    expect(kit.disconnect).toHaveBeenCalledTimes(1)
    expect((caught as unknown as Error).message).toMatch(WC_STALE_RE)
  })

  it('passes non-stale errors through unchanged (no clear, no recovery)', async () => {
    const kit = {
      ...fakeKit,
      signMessage: vi.fn(async () => {
        throw new Error('User rejected the request')
      }),
      disconnect: vi.fn(async () => {}),
    }
    let caught: Error | null = null
    function Probe4() {
      const w = useWallet()
      return (
        <button onClick={() => w.signMessage('MSG').catch((e: Error) => (caught = e))}>
          signReject
        </button>
      )
    }
    render(<WalletProvider kit={kit as any}><Probe4 /></WalletProvider>)
    fireEvent.click(screen.getByText('signReject'))

    await waitFor(() => expect(caught).not.toBeNull())
    expect(kit.disconnect).not.toHaveBeenCalled()
    expect((caught as unknown as Error).message).toBe('User rejected the request')
  })

  it('signMessage: resets address to null on a mid-sign stale error, so the next login click re-pairs instead of looping', async () => {
    const kit = {
      ...fakeKit,
      openModal: vi.fn(async ({ onWalletSelected }: any) => onWalletSelected({ id: 'freighter' })),
      getAddress: vi.fn(async () => ({ address: 'GDCPLKM7CKTQ...SC6X' })),
      signMessage: vi.fn(async () => {
        throw staleWcError()
      }),
      disconnect: vi.fn(async () => {}),
    }
    function LoginLikeProbe() {
      const w = useWallet()
      const [log, setLog] = React.useState<string[]>([])
      const login = async () => {
        try {
          const addr = w.address || (await w.connect())
          setLog((l) => [...l, `used:${addr}`])
          await w.signMessage('MSG')
        } catch (e) {
          setLog((l) => [...l, `err:${(e as Error).message}`])
        }
      }
      return (
        <div>
          <button onClick={login}>login</button>
          <span>{w.address ?? 'none'}</span>
          <span data-testid="log">{log.join('|')}</span>
        </div>
      )
    }
    render(<WalletProvider kit={kit as any}><LoginLikeProbe /></WalletProvider>)

    fireEvent.click(screen.getByText('login'))
    await waitFor(() =>
      expect(screen.getByTestId('log').textContent).toMatch(/session expired.*reconnect/i),
    )
    expect(screen.getByText('none')).toBeTruthy()
    expect(kit.openModal).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByText('login'))
    await waitFor(() => expect(kit.openModal).toHaveBeenCalledTimes(2))
  })

  it('happy path: connect/sign never invoke recovery or touch storage', async () => {
    localStorage.setItem('wc@2:should-survive', '1')
    const kit = { ...fakeKit, disconnect: vi.fn(async () => {}) }
    render(<WalletProvider kit={kit as any}><Probe /></WalletProvider>)
    fireEvent.click(screen.getByText('connect'))
    await waitFor(() => expect(screen.getByText('GDCPLKM7CKTQ...SC6X')).toBeTruthy())

    expect(kit.disconnect).not.toHaveBeenCalled()
    expect(localStorage.getItem('wc@2:should-survive')).toBe('1')
  })
})
