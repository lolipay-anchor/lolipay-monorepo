import { describe, it, expect, vi } from 'vitest'
import { disputeFilerDiverges } from '@/app/orders/page'
import type { Order } from '@lolipay/api-client'

vi.mock('@/lib/wallet-kit', () => ({ getDefaultKit: vi.fn(() => ({})) }))

const base = {
  id: 'o1',
  user_address: 'GUSER',
  lp_wallet: 'GLP',
  dispute_by: 'user',
} as unknown as Order

function withOrder(over: Record<string, unknown>): Order {
  return { ...base, ...over } as unknown as Order
}

describe('the console must say when the filer is not the signer', () => {
  it('is quiet when the party who filed is the party who signed', () => {
    expect(
      disputeFilerDiverges(withOrder({ dispute_by: 'user', on_chain_disputed_by: 'GUSER' })),
    ).toBe(false)
    expect(
      disputeFilerDiverges(withOrder({ dispute_by: 'lp', on_chain_disputed_by: 'GLP' })),
    ).toBe(false)
  })

  it('warns when someone else signed the dispute the filing claims', () => {
    expect(
      disputeFilerDiverges(withOrder({ dispute_by: 'user', on_chain_disputed_by: 'GLP' })),
    ).toBe(true)
  })

  it('warns when the signer is neither party, which is how a resolver escalation looks', () => {
    expect(
      disputeFilerDiverges(withOrder({ dispute_by: 'user', on_chain_disputed_by: 'GRESOLVER' })),
    ).toBe(true)
  })

  it('warns rather than reassures when the order has no wallet to compare against', () => {
    expect(
      disputeFilerDiverges(
        withOrder({ dispute_by: 'lp', lp_wallet: null, on_chain_disputed_by: 'GLP' }),
      ),
    ).toBe(true)
  })

  it('says nothing at all when the chain has not been heard from', () => {
    expect(disputeFilerDiverges(withOrder({ on_chain_disputed_by: null }))).toBe(false)
  })

  it('says nothing when nobody filed, since there is no claim to contradict', () => {
    expect(
      disputeFilerDiverges(withOrder({ dispute_by: null, on_chain_disputed_by: 'GLP' })),
    ).toBe(false)
  })
})
