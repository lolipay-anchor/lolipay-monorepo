import { describe, it, expect, vi } from 'vitest'

const authModal = vi.fn(async () => ({ address: 'GTEST' }))
const on = vi.fn((_type: unknown, cb: (e: { payload: { id: string } }) => void) => {
  cb({ payload: { id: 'freighter' } })
  return () => {}
})

vi.mock('@creit.tech/stellar-wallets-kit', () => ({
  StellarWalletsKit: {
    init: vi.fn(),
    on,
    authModal,
    setWallet: vi.fn(),
    getAddress: vi.fn(async () => ({ address: 'GTEST' })),
    signTransaction: vi.fn(),
    signMessage: vi.fn(),
    disconnect: vi.fn(async () => {}),
  },
  Networks: { TESTNET: 'Test SDF Network ; September 2015' },
  KitEventType: { WALLET_SELECTED: 'WALLET_SELECTED' },
}))
vi.mock('@creit.tech/stellar-wallets-kit/modules/freighter', () => ({
  FreighterModule: class {},
}))
vi.mock('@creit.tech/stellar-wallets-kit/modules/wallet-connect', () => ({
  WalletConnectModule: class {},
  WalletConnectTargetChain: { TESTNET: 'testnet' },
}))

describe('wallet-kit openModal (reconnect TDZ regression)', () => {
  it('survives on() firing synchronously at registration, and ignores the replay', async () => {
    const { getDefaultKit } = await import('@/lib/wallet-kit')
    const kit = getDefaultKit()
    const onWalletSelected = vi.fn()

    await expect(kit.openModal({ onWalletSelected })).resolves.toBeUndefined()

    expect(onWalletSelected).not.toHaveBeenCalled()
    expect(authModal).toHaveBeenCalledTimes(1)
  })
})
