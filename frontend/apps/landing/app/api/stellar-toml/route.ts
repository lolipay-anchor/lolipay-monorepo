import { Networks, StrKey } from '@stellar/stellar-sdk'

export const dynamic = 'force-dynamic'

const HEADERS = {
  'content-type': 'text/plain; charset=utf-8',
  'access-control-allow-origin': '*',
  'cache-control': 'no-store',
}

function httpsWithoutTrailingSlash(value: string): string | null {
  if (!value.startsWith('https://')) return 'must start with https://'
  if (value.endsWith('/')) return 'must not end with a slash'
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
  { key: 'WEB_AUTH_ENDPOINT', env: 'WEB_AUTH_ENDPOINT', check: httpsWithoutTrailingSlash },
  {
    key: 'TRANSFER_SERVER_SEP0024',
    env: 'TRANSFER_SERVER_SEP0024',
    check: httpsWithoutTrailingSlash,
  },
]

function render(): { toml: string } | { problem: string } {
  const lines: string[] = []
  for (const field of FIELDS) {
    const value = process.env[field.env]
    if (!value) return { problem: `${field.env} is not set` }
    if (value.includes('"')) return { problem: `${field.env} must not contain a quote` }
    const complaint = field.check?.(value)
    if (complaint) return { problem: `${field.env} ${complaint}` }
    lines.push(`${field.key}="${value}"`)
  }
  return { toml: lines.join('\n') + '\n' }
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
