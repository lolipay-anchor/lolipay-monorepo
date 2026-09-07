const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? ''
const IS_TESTNET = RPC === '' || RPC.includes('testnet')

const NETWORK = process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? (IS_TESTNET ? 'testnet' : null)

export function txUrl(hash: string): string | null {
  if (!NETWORK) return null
  return `https://stellar.expert/explorer/${NETWORK}/tx/${encodeURIComponent(hash)}`
}
