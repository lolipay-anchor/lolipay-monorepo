import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { GET } from '../app/api/stellar-toml/route'

const SIGNING_PUBLIC = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7))
const A_SEED = StrKey.encodeEd25519SecretSeed(Buffer.alloc(32, 9))

const GOOD = {
  STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  SEP10_SIGNING_PUBLIC: SIGNING_PUBLIC,
  WEB_AUTH_ENDPOINT: 'https://api.lolipay.app/auth',
  TRANSFER_SERVER_SEP0024: 'https://api.lolipay.app/sep24',
}

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const [k, v] of Object.entries(GOOD)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

async function body() {
  return (await GET()).text()
}

describe('the anchor toml is served the way SEP-1 requires', () => {
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

  it('stays far below the 100KB the suite allows, and is not empty', async () => {
    const size = Buffer.byteLength(await body(), 'utf8')

    expect(size).toBeGreaterThan(0)
    expect(size).toBeLessThan(100_000)
  })
})

describe('the toml carries the fields the acceptance suite reads', () => {
  it('carries the network passphrase it was configured with, not a built-in one', async () => {
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015'

    expect(await body()).toMatch(
      /^NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015"$/m,
    )
  })

  it('carries the signing key', async () => {
    expect(await body()).toMatch(new RegExp(`^SIGNING_KEY="${SIGNING_PUBLIC}"$`, 'm'))
  })

  it('carries the web auth endpoint', async () => {
    expect(await body()).toMatch(/^WEB_AUTH_ENDPOINT="https:\/\/api\.lolipay\.app\/auth"$/m)
  })

  it('carries the sep24 transfer server', async () => {
    expect(await body()).toMatch(
      /^TRANSFER_SERVER_SEP0024="https:\/\/api\.lolipay\.app\/sep24"$/m,
    )
  })

  it('emits every line as a quoted key and value, so the file parses', async () => {
    const lines = (await body()).split('\n').filter((l) => l.trim() !== '')
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) {
      expect(line).toMatch(/^[A-Z0-9_]+="[^"]*"$/)
    }
  })

  it('emits exactly the fields it means to, and nothing else', async () => {
    const keys = (await body())
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.split('=')[0])

    expect(keys).toEqual([
      'NETWORK_PASSPHRASE',
      'SIGNING_KEY',
      'WEB_AUTH_ENDPOINT',
      'TRANSFER_SERVER_SEP0024',
    ])
  })
})

describe('a misconfigured anchor refuses to describe itself', () => {
  it.each(Object.keys(GOOD))('refuses when %s is missing', async (key) => {
    delete process.env[key]

    const res = await GET()

    expect(res.status).toBe(503)
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/)
    expect(await res.text()).toContain(key)
  })

  it('never emits a partial toml when it refuses', async () => {
    delete process.env.SEP10_SIGNING_PUBLIC

    expect(await body()).not.toMatch(/NETWORK_PASSPHRASE=/)
  })

  it.each(['WEB_AUTH_ENDPOINT', 'TRANSFER_SERVER_SEP0024'])(
    'refuses a plaintext %s, which the suite rejects',
    async (key) => {
      process.env[key] = 'http://api.lolipay.app/auth'

      expect((await GET()).status).toBe(503)
    },
  )

  it.each(['WEB_AUTH_ENDPOINT', 'TRANSFER_SERVER_SEP0024'])(
    'refuses a trailing slash on %s, which the suite rejects',
    async (key) => {
      process.env[key] = 'https://api.lolipay.app/auth/'

      expect((await GET()).status).toBe(503)
    },
  )

  it('refuses a signing key whose checksum does not hold, which a regex would accept', async () => {
    const last = SIGNING_PUBLIC.slice(-1)
    const swapped = SIGNING_PUBLIC.slice(0, -1) + (last === 'A' ? 'B' : 'A')
    expect(swapped).toMatch(/^G[A-Z2-7]{55}$/)
    expect(StrKey.isValidEd25519PublicKey(swapped)).toBe(false)
    process.env.SEP10_SIGNING_PUBLIC = swapped

    expect((await GET()).status).toBe(503)
  })

  it('refuses a secret seed offered where the public key belongs', async () => {
    process.env.SEP10_SIGNING_PUBLIC = A_SEED

    const res = await GET()

    expect(res.status).toBe(503)
    expect(await res.text()).not.toContain(A_SEED)
  })

  it.each(['Test', 'Test SDF Network', 'some other network'])(
    'refuses %s, which is not a network the suite recognises',
    async (passphrase) => {
      process.env.STELLAR_NETWORK_PASSPHRASE = passphrase

      expect((await GET()).status).toBe(503)
    },
  )

  it('refuses a value carrying a quote, which would break the file', async () => {
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test "SDF" Network'

    expect((await GET()).status).toBe(503)
  })

  it.each([
    ['a newline', 'https://api.lolipay.app/auth\nSIGNING_KEY="GEVIL"'],
    ['a carriage return', 'https://api.lolipay.app/auth\r'],
    ['a tab', 'https://api.lolipay.app/au\tth'],
    ['a backslash', 'https://api.lolipay.app/au\\th'],
  ])('refuses %s, which the gate tolerates and a real wallet does not', async (_n, value) => {
    process.env.WEB_AUTH_ENDPOINT = value

    expect((await GET()).status).toBe(503)
  })

  it('refuses a trailing space rather than trimming it away silently', async () => {
    process.env.WEB_AUTH_ENDPOINT = 'https://api.lolipay.app/auth '

    expect((await GET()).status).toBe(503)
  })

  it('names padding as the fault, so the operator does not hunt the wrong thing', async () => {
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015 '

    const res = await GET()

    expect(res.status).toBe(503)
    expect(await res.text()).toMatch(/padded with whitespace/)
  })

  it('names a control character as the fault rather than blaming the value', async () => {
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Test SDF Network ; September 2015\u0007'

    const res = await GET()

    expect(res.status).toBe(503)
    expect(await res.text()).toMatch(/control character/)
  })

  it.each([
    ['a query string', 'https://api.lolipay.app/auth?v=1'],
    ['a fragment', 'https://api.lolipay.app/auth#frag'],
    ['no host at all', 'https:///auth'],
  ])('refuses an endpoint with %s, which would destroy the account parameter', async (_n, v) => {
    process.env.WEB_AUTH_ENDPOINT = v

    expect((await GET()).status).toBe(503)
  })

  it('answers a refusal with the same headers it answers success with', async () => {
    delete process.env.SEP10_SIGNING_PUBLIC

    const res = await GET()

    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('cache-control')).toMatch(/no-store/)
  })
})
