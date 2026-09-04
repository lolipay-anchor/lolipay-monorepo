import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import { GET, PROSE } from '../app/api/stellar-toml/route'

const SIGNING_PUBLIC = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7))
const A_SEED = StrKey.encodeEd25519SecretSeed(Buffer.alloc(32, 9))

const GOOD = {
  STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  SEP10_SIGNING_PUBLIC: SIGNING_PUBLIC,
  WEB_AUTH_ENDPOINT: 'https://api.lolipay.app/auth',
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

  it('does not advertise a sep24 transfer server when none is configured', async () => {
    delete process.env.TRANSFER_SERVER_SEP0024
    expect(await body()).not.toMatch(/TRANSFER_SERVER_SEP0024/)
  })

  it('advertises the sep24 transfer server once one is configured, or no wallet can find it', async () => {
    process.env.TRANSFER_SERVER_SEP0024 = 'https://api.lolipay.app/sep24'
    try {
      expect(await body()).toMatch(
        /^TRANSFER_SERVER_SEP0024="https:\/\/api\.lolipay\.app\/sep24"$/m,
      )
    } finally {
      delete process.env.TRANSFER_SERVER_SEP0024
    }
  })

  it('omits a sep24 transfer server it cannot trust rather than serving a broken one', async () => {
    process.env.TRANSFER_SERVER_SEP0024 = 'http://api.lolipay.app/sep24/'
    try {
      const served = await body()
      expect(served).not.toMatch(/TRANSFER_SERVER_SEP0024/)
      expect(served).toMatch(/^SIGNING_KEY=/m)
    } finally {
      delete process.env.TRANSFER_SERVER_SEP0024
    }
  })

  it('emits every top-level line as a quoted key and value, so the file parses', async () => {
    const all = (await body()).split('\n').filter((l) => l.trim() !== '')
    const head = all.slice(0, all.findIndex((l) => l.startsWith('[')))
    expect(head.length).toBeGreaterThan(0)
    for (const line of head) {
      expect(line).toMatch(/^[A-Z0-9_]+="[^"]*"$/)
    }
    for (const line of all.filter((l) => l.startsWith('['))) {
      expect(line).toMatch(/^\[{1,2}[A-Z]+\]{1,2}$/)
    }
  })

  it('emits exactly the top-level fields it means to, and nothing else', async () => {
    const all = (await body()).split('\n').filter((l) => l.trim() !== '')
    const keys = all
      .slice(0, all.findIndex((l) => l.startsWith('[')))
      .map((l) => l.split('=')[0])

    expect(keys).toEqual([
      'NETWORK_PASSPHRASE',
      'SIGNING_KEY',
      'WEB_AUTH_ENDPOINT',
      'VERSION',
    ])
  })

  it('keeps the sep24 transfer server inside the head block, in order, when it is configured', async () => {
    process.env.TRANSFER_SERVER_SEP0024 = 'https://api.lolipay.app/sep24'
    try {
      const all = (await body()).split('\n').filter((l) => l.trim() !== '')
      const keys = all
        .slice(0, all.findIndex((l) => l.startsWith('[')))
        .map((l) => l.split('=')[0])
      expect(keys).toEqual([
        'NETWORK_PASSPHRASE',
        'SIGNING_KEY',
        'WEB_AUTH_ENDPOINT',
        'TRANSFER_SERVER_SEP0024',
        'VERSION',
      ])
    } finally {
      delete process.env.TRANSFER_SERVER_SEP0024
    }
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

  it.each(['WEB_AUTH_ENDPOINT'])(
    'refuses a plaintext %s, which the suite rejects',
    async (key) => {
      process.env[key] = 'http://api.lolipay.app/auth'

      expect((await GET()).status).toBe(503)
    },
  )

  it.each(['WEB_AUTH_ENDPOINT'])(
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

describe('the currencies section', () => {
  const ISSUER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 11))

  beforeEach(() => {
    process.env.USDC_ASSET_CODE = 'TUSDC'
    process.env.USDC_ASSET_ISSUER = ISSUER
  })

  afterEach(() => {
    delete process.env.USDC_ASSET_CODE
    delete process.env.USDC_ASSET_ISSUER
  })

  it('carries every field the acceptance suite requires', async () => {
    const body = await (await GET()).text()
    expect(body).toContain('[[CURRENCIES]]')
    for (const key of ['code', 'issuer', 'status', 'is_asset_anchored', 'anchor_asset_type', 'desc']) {
      expect(body).toContain(`${key}=`)
    }
  })

  it('tells the truth about a test asset rather than claiming it is anchored', async () => {
    const body = await (await GET()).text()
    expect(body).toContain('status="test"')
    expect(body).toContain('is_asset_anchored=false')
    expect(body).toMatch(/desc="[^"]*[Nn]ot redeemable/)
  })

  it('calls the asset what it is: crypto, not fiat', async () => {
    expect(await body()).toContain('anchor_asset_type="crypto"')
  })

  it('states no issuance policy, because lolipay does not issue this asset', async () => {
    const t = await body()
    expect(t).not.toContain('is_unlimited')
    expect(t).not.toContain('fixed_number')
    expect(t).not.toContain('max_number')
  })

  it('names the corridor in desc, which is the field a wallet actually renders', async () => {
    const t = await body()
    expect(t).toMatch(/desc=".*IDR.*USDC.*"/)
    expect(t).toMatch(/conditions=".*IDR.*"/)
    expect(t).toMatch(/ORG_DESCRIPTION=".*Indonesia.*"/)
  })

  it('says whose settlement it is describing, so desc and conditions cannot read as contradicting', async () => {
    const t = await body()
    expect(t).toMatch(/conditions="lolipay /)
  })

  it('claims no more about collateral than ADR 0019 actually guarantees', async () => {
    const t = await body()
    expect(t).not.toMatch(/each trade is backed/)
    expect(t).toMatch(/staked, slashable collateral rather than a treasury account/)
  })

  it('discloses that a memo does not buy a separately verified identity, which SEP-10 asks for and this anchor does not provide', async () => {
    const t = await body()
    expect(t).toMatch(/conditions=".*Identity verification is bound to the verified person rather than to a SEP-10 subject string.*"/)
    expect(t).toMatch(/a memo or muxed subaccount does not create a separately verified identity/)
  });

  it('names the muxed subaccount too, because it collapses to the base account exactly as a memo does', async () => {
    const t = await body()
    expect(t).toMatch(/memo or muxed subaccount/)
  });

  it('discloses that erasure crosses the memos as well, which is the consequence a reader would otherwise miss', async () => {
    const t = await body()
    expect(t).toMatch(/an erasure request under any of them erases it for all/)
  });

  it('states the deposit scope as the rule actually is, and claims nothing about what GET \/customer reports', async () => {
    const t = await body()
    expect(t).not.toMatch(/every session/)
    expect(t).toMatch(/authorises deposits for any Stellar account this anchor currently accepts for that person/)
    expect(t).not.toMatch(/deposits for that account/)
  });

  it('does not claim to refuse shared accounts, because PUT \/customer answers a memo with its own customer id', async () => {
    const t = await body()
    expect(t).not.toMatch(/does not serve/i)
    expect(t).not.toMatch(/omnibus|pooled/i)
    expect(t).not.toMatch(/no shared account/i)
  });

  it('keeps every hardcoded sentence in a shape the document can carry, which the render guard then enforces', async () => {
    const clean = PROSE.map((p) => p.value)
    for (const value of clean) {
      expect(value).not.toContain('"')
      expect(value).not.toContain('\\')
      expect(value).toBe(value.trim())
    }
    expect(PROSE.map((p) => p.name).sort()).toEqual(['CORRIDOR', 'ORG_DESCRIPTION', 'TESTNET_DESC'])
  });

  it('describes the organisation without claiming anything it cannot show', async () => {
    const t = await body()
    expect(t).toContain('[DOCUMENTATION]')
    expect(t).toContain('ORG_NAME="lolipay"')
    expect(t).toContain('ORG_URL="https://lolipay.app"')
    expect(t).not.toMatch(/ORG_LICENSE|ORG_PHYSICAL_ADDRESS|ORG_PHONE_NUMBER/)
  })

  it('puts the bare keys before the first table header, or the file parses as something else', async () => {
    const t = await body()
    expect(t).toContain('[[CURRENCIES]]')
    expect(t.indexOf('VERSION=')).toBeLessThan(t.indexOf('[[CURRENCIES]]'))
    expect(t.indexOf('[[CURRENCIES]]')).toBeLessThan(t.indexOf('[DOCUMENTATION]'))
  })

  it('says plainly on the test network that the asset is not redeemable', async () => {
    const body = await (await GET()).text()
    expect(body).toContain('status="test"')
    expect(body).toContain('is_asset_anchored=false')
    expect(body).toContain('not redeemable')
  })

  it('omits itself rather than taking the whole document down', async () => {
    delete process.env.USDC_ASSET_ISSUER
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain('[[CURRENCIES]]')
    expect(body).toContain('WEB_AUTH_ENDPOINT=')
    expect(body).toContain('SIGNING_KEY=')
  })

  it('refuses to invent the public-network claims from the network passphrase alone', async () => {
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015'
    const body = await (await GET()).text()
    expect(body).not.toContain('[[CURRENCIES]]')
    expect(body).not.toContain('is_asset_anchored=true')
    expect(body).not.toContain('status="live"')
  })

  it('publishes the public-network claims once somebody has actually decided them', async () => {
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015'
    process.env.CURRENCY_STATUS = 'live'
    process.env.CURRENCY_IS_ASSET_ANCHORED = 'false'
    process.env.CURRENCY_DESC = 'USDC settled through lolipay peer-to-peer escrow.'
    const body = await (await GET()).text()
    expect(body).toContain('[[CURRENCIES]]')
    expect(body).toContain('status="live"')
    expect(body).toContain('is_asset_anchored=false')
  })

  it('omits itself when the issuer is not a Stellar key, rather than publishing nonsense', async () => {
    process.env.USDC_ASSET_ISSUER = 'not-a-key'
    const body = await (await GET()).text()
    expect(body).not.toContain('[[CURRENCIES]]')
    expect(body).toContain('WEB_AUTH_ENDPOINT=')
  })

  it('omits itself when the code could never be a Stellar asset code', async () => {
    process.env.USDC_ASSET_CODE = 'THIS_IS_FAR_TOO_LONG'
    const body = await (await GET()).text()
    expect(body).not.toContain('[[CURRENCIES]]')
  })

  it('never lets a quote break the document it is embedded in', async () => {
    process.env.USDC_ASSET_CODE = 'A"B'
    const body = await (await GET()).text()
    expect(body).not.toContain('[[CURRENCIES]]')
    expect(body.split('"').length % 2).toBe(1)
  })
})

describe('KYC_SERVER is announced only once it exists', () => {
  const setKyc = (value: string | undefined) => {
    if (value === undefined) delete process.env.KYC_SERVER
    else process.env.KYC_SERVER = value
  }
  afterEach(() => setKyc(undefined))

  it('announces it when it is set', async () => {
    setKyc('https://api.lolipay.app')
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.text()).toMatch(/^KYC_SERVER="https:\/\/api\.lolipay\.app"$/m)
  })

  it('serves a complete toml when it is not set, rather than refusing to describe the anchor', async () => {
    setKyc(undefined)
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toMatch(/KYC_SERVER/)
    expect(body).toMatch(/SIGNING_KEY=/)
    expect(body).toMatch(/WEB_AUTH_ENDPOINT=/)
    expect(body).toMatch(/\[DOCUMENTATION\]/)
  })

  it.each([
    ['plain http', 'http://api.lolipay.app'],
    ['a trailing slash', 'https://api.lolipay.app/'],
    ['a query string', 'https://api.lolipay.app?a=1'],
    ['a quote', 'https://api.lolipay.app/"x'],
  ])('omits it rather than serving something broken when it carries %s', async (_name, value) => {
    setKyc(value)
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.text()).not.toMatch(/KYC_SERVER/)
  })
})
