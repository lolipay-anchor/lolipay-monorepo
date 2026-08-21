import { Asset, Operation, TransactionBuilder, BASE_FEE, rpc } from '@stellar/stellar-sdk'
import { USDC_CODE, USDC_ISSUER, HORIZON_URL } from './usdcAsset'

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'https://soroban-testnet.stellar.org'
const PASSPHRASE = process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ?? 'Test SDF Network ; September 2015'

export type TrustlineState = 'ok' | 'missing' | 'unfunded'

export async function checkUsdcTrustline(address: string): Promise<TrustlineState> {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${encodeURIComponent(address)}`)
    if (res.status === 404) return 'unfunded'
    if (!res.ok) return 'ok'
    const data = await res.json()
    const has = (data.balances ?? []).some(
      (b: { asset_code?: string; asset_issuer?: string }) =>
        b.asset_code === USDC_CODE && b.asset_issuer === USDC_ISSUER,
    )
    return has ? 'ok' : 'missing'
  } catch {
    return 'ok'
  }
}

export async function buildChangeTrustXdr(address: string): Promise<string> {
  const server = new rpc.Server(RPC_URL)
  const account = await server.getAccount(address)
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: new Asset(USDC_CODE, USDC_ISSUER) }))
    .setTimeout(180)
    .build()
  return tx.toXDR()
}

export { PASSPHRASE as networkPassphrase }
