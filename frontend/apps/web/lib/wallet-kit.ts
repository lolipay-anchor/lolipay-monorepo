import {
  StellarWalletsKit,
  Networks,
  KitEventType,
} from '@creit.tech/stellar-wallets-kit'
import { FreighterModule } from '@creit.tech/stellar-wallets-kit/modules/freighter'
import {
  WalletConnectModule,
  WalletConnectTargetChain,
} from '@creit.tech/stellar-wallets-kit/modules/wallet-connect'

const TESTNET_PASSPHRASE = 'Test SDF Network ; September 2015'

let initialised = false

function ensureInitialised() {
  if (initialised) return

  initialised = true

  const modules = [new FreighterModule()]

  const wcProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID
  if (wcProjectId) {
    modules.push(
      new WalletConnectModule({
        projectId: wcProjectId,
        metadata: {
          name: 'lolipay',
          description: 'P2P IDR ⇄ USDC on Stellar',
          url: 'https://app.lolipay.app',
          icons: ['https://app.lolipay.app/icon.png'],
        },
        allowedChains: [WalletConnectTargetChain.TESTNET],
      }),
    )
  }

  StellarWalletsKit.init({
    network: Networks.TESTNET,
    modules,
  })
}

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
  disconnect?: () => Promise<void>
}

let _kit: Kit | null = null

export function getDefaultKit(): Kit {
  if (_kit) return _kit

  ensureInitialised()

  _kit = {
    openModal: async ({ onWalletSelected }) => {
      let off = () => {}
      let armed = false
      off = StellarWalletsKit.on(KitEventType.WALLET_SELECTED, (event) => {
        if (!armed) return
        const id = event.payload.id
        if (id) onWalletSelected({ id })
      })
      armed = true

      try {
        await StellarWalletsKit.authModal()
      } finally {
        off()
      }
    },

    setWallet: (id: string) => {
      StellarWalletsKit.setWallet(id)
    },

    getAddress: () => StellarWalletsKit.getAddress(),

    signTransaction: (xdr: string, opts: { networkPassphrase: string }) =>
      StellarWalletsKit.signTransaction(xdr, {
        networkPassphrase: opts.networkPassphrase ?? TESTNET_PASSPHRASE,
      }),

    signMessage: (message: string, opts?: { networkPassphrase?: string; address?: string }) =>
      StellarWalletsKit.signMessage(message, {
        networkPassphrase: opts?.networkPassphrase ?? TESTNET_PASSPHRASE,
        address: opts?.address,
      }),

    disconnect: () => StellarWalletsKit.disconnect(),
  }

  return _kit
}
