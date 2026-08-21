import { describe, it, expect, vi, afterEach } from 'vitest'
import { checkUsdcTrustline } from '@/lib/trustline'
import { USDC_ISSUER } from '@/lib/usdcAsset'

const ISSUER = USDC_ISSUER

describe('checkUsdcTrustline', () => {
  const realFetch = global.fetch
  afterEach(() => {
    global.fetch = realFetch
  })

  it('ok when the account already holds the USDC asset', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ balances: [{ asset_code: 'TUSDC', asset_issuer: ISSUER }] }),
    }) as any
    expect(await checkUsdcTrustline('GABC')).toBe('ok')
  })

  it('missing when the account has no USDC trustline', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ balances: [{ asset_type: 'native' }] }),
    }) as any
    expect(await checkUsdcTrustline('GABC')).toBe('missing')
  })

  it('unfunded on a 404 (account not created)', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as any
    expect(await checkUsdcTrustline('GABC')).toBe('unfunded')
  })

  it('ok (no false nag) on a transient lookup error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as any
    expect(await checkUsdcTrustline('GABC')).toBe('ok')
  })
})
