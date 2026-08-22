import { describe, it, expect } from 'vitest'
import { GET } from '../app/api/stellar-toml/route'

describe('the anchor toml SEP-1 requires', () => {
  it('is served as plain text', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
  })

  it('allows any origin, which SEP-1 requires and a credentialed policy forbids', async () => {
    const res = await GET()
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('access-control-allow-credentials')).toBeNull()
  })

  it('is never cached, so a rotated key is never served from a stale copy', async () => {
    const res = await GET()
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
  })

  it('carries the network passphrase of the network it is on', async () => {
    const body = await (await GET()).text()
    expect(body).toMatch(/^NETWORK_PASSPHRASE="Test SDF Network ; September 2015"$/m)
  })
})
