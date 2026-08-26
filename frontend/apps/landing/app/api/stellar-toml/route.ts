import { Networks, StrKey } from '@stellar/stellar-sdk'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
}

function httpsEndpoint(value: string): string | null {
  if (!value.startsWith('https://')) return 'must start with https://'
  if (value.endsWith('/')) return 'must not end with a slash'
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'must be a URL'
  }
  if (parsed.search) return 'must not carry a query string, which would swallow ?account='
  if (parsed.hash) return 'must not carry a fragment, which would drop the query'
  const canonical =
    parsed.pathname === '/' && parsed.href.endsWith('/') ? parsed.href.slice(0, -1) : parsed.href
  if (canonical !== value) return `must already be canonical, which would be ${canonical}`
  return null
}

function usableInAToml(value: string): string | null {
  if (value !== value.trim()) return 'must not be padded with whitespace'
  if (/[\u0000-\u001F\u007F]/.test(value)) return 'must not contain a control character'
  if (value.includes('"')) return 'must not contain a quote'
  if (value.includes('\\')) return 'must not contain a backslash'
  return null
}

function knownNetwork(value: string): string | null {
  return value === Networks.TESTNET || value === Networks.PUBLIC
    ? null
    : 'must be the passphrase of a Stellar network the suite recognises'
}

function stellarPublicKey(value: string): string | null {
  return StrKey.isValidEd25519PublicKey(value)
    ? null
    : 'must be a Stellar public key, checksum included'
}

const FIELDS: { key: string; env: string; check?: (value: string) => string | null }[] = [
  { key: 'NETWORK_PASSPHRASE', env: 'STELLAR_NETWORK_PASSPHRASE', check: knownNetwork },
  { key: 'SIGNING_KEY', env: 'SEP10_SIGNING_PUBLIC', check: stellarPublicKey },
  { key: 'WEB_AUTH_ENDPOINT', env: 'WEB_AUTH_ENDPOINT', check: httpsEndpoint },
  {
    key: 'TRANSFER_SERVER_SEP0024',
    env: 'TRANSFER_SERVER_SEP0024',
    check: httpsEndpoint,
  },
]

export function currenciesSection(): { toml: string } | { omitted: string } {
  const code = process.env.USDC_ASSET_CODE
  const issuer = process.env.USDC_ASSET_ISSUER
  if (!code) return { omitted: 'USDC_ASSET_CODE is not set' }
  if (!issuer) return { omitted: 'USDC_ASSET_ISSUER is not set' }

  for (const [name, value] of [
    ['USDC_ASSET_CODE', code],
    ['USDC_ASSET_ISSUER', issuer],
  ] as const) {
    const unusable = usableInAToml(value)
    if (unusable) return { omitted: `${name} ${unusable}` }
  }
  if (!/^[A-Za-z0-9]{1,12}$/.test(code)) {
    return { omitted: 'USDC_ASSET_CODE must be 1 to 12 alphanumeric characters' }
  }
  const badIssuer = stellarPublicKey(issuer)
  if (badIssuer) return { omitted: `USDC_ASSET_ISSUER ${badIssuer}` }

  const anchored = process.env.STELLAR_NETWORK_PASSPHRASE === Networks.PUBLIC

  return {
    toml: [
      '',
      '[[CURRENCIES]]',
      `code="${code}"`,
      `issuer="${issuer}"`,
      `status="${anchored ? 'live' : 'test'}"`,
      `is_asset_anchored=${anchored ? 'true' : 'false'}`,
      'anchor_asset_type="fiat"',
      `desc="${anchored ? 'USDC settled through lolipay peer-to-peer escrow.' : 'Test asset on the Stellar test network. Not redeemable and not backed by anything.'}"`,
    ].join('\n'),
  }
}

function render(): { toml: string } | { problem: string } {
  const lines: string[] = []
  for (const field of FIELDS) {
    const value = process.env[field.env]
    if (value === undefined) return { problem: `${field.env} is not set` }
    if (value === '') return { problem: `${field.env} is empty` }
    const unusable = usableInAToml(value)
    if (unusable) return { problem: `${field.env} ${unusable}` }
    const complaint = field.check?.(value)
    if (complaint) return { problem: `${field.env} ${complaint}` }
    lines.push(`${field.key}="${value}"`)
  }
  const currencies = currenciesSection()
  const body = 'toml' in currencies ? lines.join('\n') + currencies.toml + '\n' : lines.join('\n') + '\n'
  return { toml: body }
}

export async function GET(): Promise<Response> {
  const result = render()
  if ('problem' in result) {
    return new Response(
      `this anchor is not configured to describe itself: ${result.problem}\n`,
      { status: 503, headers: HEADERS },
    )
  }
  return new Response(result.toml, { status: 200, headers: HEADERS })
}
