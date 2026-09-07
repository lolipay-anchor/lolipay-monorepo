import { describe, it, expect, vi, afterEach } from 'vitest'

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

  it('builds the stellar.expert transaction URL for the configured network, encoding the hash', async () => {
    const fresh = await txUrlWith('testnet', '')
    expect(fresh('ab'.repeat(32))).toBe(`https://stellar.expert/explorer/testnet/tx/${'ab'.repeat(32)}`)
    expect(fresh('a b')).toBe('https://stellar.expert/explorer/testnet/tx/a%20b')
  })

  it('infers testnet only while the variable is unset and the RPC is not a mainnet one', async () => {
    const fresh = await txUrlWith('', '')
    expect(fresh('ab'.repeat(32))).toBe(`https://stellar.expert/explorer/testnet/tx/${'ab'.repeat(32)}`)
    const mainnetRpc = await txUrlWith('', 'https://mainnet.sorobanrpc.com')
    expect(mainnetRpc('ab'.repeat(32))).toBeNull()
  })

  it('accepts public, the word stellar.expert uses for mainnet', async () => {
    const fresh = await txUrlWith('public', 'https://mainnet.sorobanrpc.com')
    expect(fresh('ab'.repeat(32))).toBe(`https://stellar.expert/explorer/public/tx/${'ab'.repeat(32)}`)
  })

  it('links nothing for a network word stellar.expert does not know, even when the RPC would have suggested testnet', async () => {
    expect((await txUrlWith('mainnet', 'https://mainnet.sorobanrpc.com'))('ab'.repeat(32))).toBeNull()
    expect((await txUrlWith('mainnet', ''))('ab'.repeat(32))).toBeNull()
  })
})
