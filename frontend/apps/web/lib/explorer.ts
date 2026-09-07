const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? ''
const IS_TESTNET = RPC === '' || RPC.includes('testnet')

const NAMED = process.env.NEXT_PUBLIC_STELLAR_NETWORK
const NETWORK = NAMED === 'testnet' || NAMED === 'public' ? NAMED : IS_TESTNET ? 'testnet' : null
const ESCROW = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID ?? null

export function escrowContractUrl(): string | null {
  if (!NETWORK || !ESCROW) return null
  return `https://stellar.expert/explorer/${NETWORK}/contract/${ESCROW}`
}

export function txUrl(hash: string): string | null {
  if (!NETWORK) return null
  return `https://stellar.expert/explorer/${NETWORK}/tx/${encodeURIComponent(hash)}`
}
