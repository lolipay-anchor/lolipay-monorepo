const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? ''
const IS_TESTNET = RPC === '' || RPC.includes('testnet')

const NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? (IS_TESTNET ? 'testnet' : null)
const ESCROW = process.env.NEXT_PUBLIC_ESCROW_CONTRACT_ID ?? null

export function escrowContractUrl(): string | null {
  if (!NETWORK || !ESCROW) return null
  return `https://stellar.expert/explorer/${NETWORK}/contract/${ESCROW}`
}
