import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const init = vi.hoisted(() => vi.fn())
const walletConnectCtor = vi.hoisted(() => vi.fn())

vi.mock('@creit.tech/stellar-wallets-kit', () => ({
  StellarWalletsKit: {
    init,
    on: vi.fn(() => () => {}),
    authModal: vi.fn(),
    setWallet: vi.fn(),
    getAddress: vi.fn(),
    signTransaction: vi.fn(),
    signMessage: vi.fn(),
    disconnect: vi.fn(),
  },
  Networks: { TESTNET: 'Test SDF Network ; September 2015' },
  KitEventType: { WALLET_SELECTED: 'WALLET_SELECTED' },
}))
vi.mock('@creit.tech/stellar-wallets-kit/modules/freighter', () => ({
  FreighterModule: class {},
}))
vi.mock('@creit.tech/stellar-wallets-kit/modules/wallet-connect', () => ({
  WalletConnectModule: class {
    constructor(opts: unknown) {
      walletConnectCtor(opts)
    }
  },
  WalletConnectTargetChain: { TESTNET: 'testnet' },
}))

describe('wallet-kit is constructed only in a browser', () => {
  beforeEach(() => {
    vi.resetModules()
    init.mockClear()
    walletConnectCtor.mockClear()
    vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', 'probe-project')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('with no window, getDefaultKit constructs no WalletConnect module and does not init the kit', async () => {
    vi.stubGlobal('window', undefined)
    const { getDefaultKit } = await import('@/lib/wallet-kit')
    getDefaultKit()
    expect(walletConnectCtor).not.toHaveBeenCalled()
    expect(init).not.toHaveBeenCalled()
  })

  it('with a window, getDefaultKit constructs the WalletConnect module once and inits the kit once', async () => {
    const { getDefaultKit } = await import('@/lib/wallet-kit')
    getDefaultKit()
    expect(walletConnectCtor).toHaveBeenCalledTimes(1)
    expect(init).toHaveBeenCalledTimes(1)
  })
})
