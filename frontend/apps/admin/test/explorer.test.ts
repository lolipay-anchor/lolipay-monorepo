import { describe, it, expect, vi, afterEach } from 'vitest'
import { txUrl } from '@/lib/explorer'

async function txUrlWith(network: string, rpc: string) {
  vi.stubEnv('NEXT_PUBLIC_STELLAR_NETWORK', network)
  vi.stubEnv('NEXT_PUBLIC_RPC_URL', rpc)
  vi.resetModules()
  return (await import('@/lib/explorer')).txUrl
}

describe('the app links the exact transaction, not the contract', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('builds the stellar.expert transaction URL for the configured network, encoding the hash', () => {
    expect(txUrl('ab'.repeat(32))).toBe(`https://stellar.expert/explorer/testnet/tx/${'ab'.repeat(32)}`)
    expect(txUrl('a b')).toBe('https://stellar.expert/explorer/testnet/tx/a%20b')
  })

  it('accepts public, the word stellar.expert uses for mainnet', async () => {
    const fresh = await txUrlWith('public', 'https://mainnet.sorobanrpc.com')
    expect(fresh('ab'.repeat(32))).toBe(`https://stellar.expert/explorer/public/tx/${'ab'.repeat(32)}`)
  })

  it('links nothing for a network word stellar.expert does not know, rather than a 404', async () => {
    const fresh = await txUrlWith('mainnet', 'https://mainnet.sorobanrpc.com')
    expect(fresh('ab'.repeat(32))).toBeNull()
  })
})
