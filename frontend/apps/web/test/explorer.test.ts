import { describe, it, expect } from 'vitest'
import { txUrl } from '@/lib/explorer'

describe('the app links the exact transaction, not the contract', () => {
  it('builds the stellar.expert transaction URL for the configured network, encoding the hash', () => {
    expect(txUrl('ab'.repeat(32))).toBe(`https://stellar.expert/explorer/testnet/tx/${'ab'.repeat(32)}`)
    expect(txUrl('a b')).toBe('https://stellar.expert/explorer/testnet/tx/a%20b')
  })
})
