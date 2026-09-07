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

  let status = 'test'
  let isAnchored = 'false'
  let desc = TESTNET_DESC
  let anchorAssetType = 'crypto'
  let anchorAsset = ''

  if (process.env.STELLAR_NETWORK_PASSPHRASE === Networks.PUBLIC) {
    const decided = {
      CURRENCY_STATUS: process.env.CURRENCY_STATUS,
      CURRENCY_IS_ASSET_ANCHORED: process.env.CURRENCY_IS_ASSET_ANCHORED,
      CURRENCY_DESC: process.env.CURRENCY_DESC,
    }
    for (const [name, value] of Object.entries(decided)) {
      if (!value) {
        return {
          omitted: `${name} is not set; on the public network what this asset is and whether it can be redeemed are claims somebody has to decide, not values to derive from the network passphrase`,
        }
      }
      const unusable = usableInAToml(value)
      if (unusable) return { omitted: `${name} ${unusable}` }
    }
    if (decided.CURRENCY_IS_ASSET_ANCHORED !== 'true' && decided.CURRENCY_IS_ASSET_ANCHORED !== 'false') {
      return { omitted: 'CURRENCY_IS_ASSET_ANCHORED must be exactly true or false' }
    }
    const STATUSES = ['live', 'dead', 'test', 'private']
    if (!STATUSES.includes(decided.CURRENCY_STATUS as string)) {
      return { omitted: `CURRENCY_STATUS must be one of ${STATUSES.join(', ')}` }
    }
    status = decided.CURRENCY_STATUS as string
    isAnchored = decided.CURRENCY_IS_ASSET_ANCHORED as string
    desc = decided.CURRENCY_DESC as string

    if (isAnchored === 'true') {
      const type = process.env.CURRENCY_ANCHOR_ASSET_TYPE
      const asset = process.env.CURRENCY_ANCHOR_ASSET
      if (!type || !asset) {
        return {
          omitted:
            'CURRENCY_ANCHOR_ASSET_TYPE and CURRENCY_ANCHOR_ASSET are not set; a token declared redeemable has to say what it is redeemable for, and this asset is issued by somebody else',
        }
      }
      for (const [name, value] of [['CURRENCY_ANCHOR_ASSET_TYPE', type], ['CURRENCY_ANCHOR_ASSET', asset]] as const) {
        const unusable = usableInAToml(value)
        if (unusable) return { omitted: `${name} ${unusable}` }
      }
      anchorAssetType = type
      anchorAsset = asset
    }
  }

  return {
    toml: [
      '',
      '[[CURRENCIES]]',
      `code="${code}"`,
      `issuer="${issuer}"`,
      `status="${status}"`,
      `is_asset_anchored=${isAnchored}`,
      `anchor_asset_type="${anchorAssetType}"`,
      ...(anchorAsset ? [`anchor_asset="${anchorAsset}"`] : []),
      `desc="${desc}"`,
      `conditions="${CORRIDOR}"`,
    ].join('\n'),
  }
}

const CORRIDOR =
  'lolipay matches peer-to-peer IDR to USDC and USDC to IDR trades over Indonesian bank ' +
  'and e-wallet rails. Settlement is non-custodial: each trade locks USDC in its own ' +
  'Soroban escrow, and liquidity is secured through staked, slashable collateral rather ' +
  'than a treasury account. Identity verification is bound to the verified person rather ' +
  'than to a SEP-10 subject string: a completed verification authorises deposits for any Stellar ' +
  'account this anchor currently accepts for that person, an erasure request under any ' +
  'of them erases it for all, and a memo or muxed subaccount does not create a ' +
  'separately verified identity. A deposit settles as a Soroban release of the net USDC to the ' +
  'base account the SEP-10 token speaks for, with no memo attached; reconcile it by the SEP-24 ' +
  'transaction id and its stellar_transaction_id.'

const ORG_DESCRIPTION =
  'A non-custodial peer-to-peer on and off ramp between Indonesian rupiah and USDC on ' +
  'Stellar, serving the Indonesia IDR corridor.'

const TESTNET_DESC =
  'USDC on the Stellar test network, used for peer-to-peer IDR to USDC trades in the ' +
  'Indonesia corridor. The test asset itself is not redeemable and is not backed by anything.'

export const PROSE: { name: string; value: string }[] = [
  { name: 'CORRIDOR', value: CORRIDOR },
  { name: 'ORG_DESCRIPTION', value: ORG_DESCRIPTION },
  { name: 'TESTNET_DESC', value: TESTNET_DESC },
]

function documentationSection(): string {
  return [
    '',
    '[DOCUMENTATION]',
    'ORG_NAME="lolipay"',
    'ORG_URL="https://lolipay.app"',
    `ORG_DESCRIPTION="${ORG_DESCRIPTION}"`,
  ].join('\n')
}

function render(): { toml: string } | { problem: string } {
  for (const { name, value } of PROSE) {
    const unusable = usableInAToml(value)
    if (unusable) return { problem: `${name} ${unusable}` }
  }
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
  const kycServer = process.env.KYC_SERVER
  if (kycServer) {
    const complaint = usableInAToml(kycServer) ?? httpsEndpoint(kycServer)
    if (complaint) {
      console.warn(`stellar.toml: KYC_SERVER was omitted — KYC_SERVER ${complaint}`)
    } else {
      lines.push(`KYC_SERVER="${kycServer}"`)
    }
  }
  const transferServer = process.env.TRANSFER_SERVER_SEP0024
  if (transferServer) {
    const complaint = usableInAToml(transferServer) ?? httpsEndpoint(transferServer)
    if (complaint) {
      console.warn(
        `stellar.toml: TRANSFER_SERVER_SEP0024 was omitted — TRANSFER_SERVER_SEP0024 ${complaint}`,
      )
    } else {
      lines.push(`TRANSFER_SERVER_SEP0024="${transferServer}"`)
    }
  }
  lines.push('VERSION="2.7.0"')
  const currencies = currenciesSection()
  if ('omitted' in currencies) {
    console.warn(`stellar.toml: the CURRENCIES section was omitted — ${currencies.omitted}`)
  }
  const head = lines.join('\n')
  const body =
    'toml' in currencies
      ? head + currencies.toml + documentationSection() + '\n'
      : head + documentationSection() + '\n'
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
