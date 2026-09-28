import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { render, screen } from '@testing-library/react'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { StrKey } from '@stellar/stellar-sdk'
import AnchorPage from '../app/anchor/page'
import { Nav } from '../components/Nav'
import { Footer } from '../components/Footer'

const SOURCES = ['app/anchor/page.tsx', 'components/Nav.tsx', 'components/Footer.tsx']

const BANNED = [
  'soon',
  'beta',
  'currently',
  'for now',
  'at the moment',
  'shortly',
  'eventually',
  'upcoming',
  'roadmap',
  'stay tuned',
  'under construction',
  'in progress',
  'todo',
  'tbd',
  'wip',
  'fixme',
  'placeholder',
  'lorem',
]

const DATING_WORD = new RegExp(`\\b(${BANNED.join('|')})\\b`, 'i')

const FINALITY_PROMISE = 'Nothing further happens on this transaction'

const TOML_URL = 'https://lolipay.app/.well-known/stellar.toml'

const SECTIONS = [
  'The anchor, and the one document that describes it',
  'What lolipay holds a key for, and what no key can reach',
  'What your wallet must be able to do, and where your token goes',
  'Identity',
  'The transaction record',
  'Try it, and who to talk to',
]

const GOOD = {
  STELLAR_NETWORK_PASSPHRASE: 'Test SDF Network ; September 2015',
  SEP10_SIGNING_PUBLIC: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 7)),
  WEB_AUTH_ENDPOINT: 'https://api.lolipay.app/auth',
  USDC_ASSET_CODE: 'USDC',
  USDC_ASSET_ISSUER: StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 11)),
}

let saved: Record<string, string | undefined>

beforeEach(() => {
  saved = {}
  for (const [key, value] of Object.entries(GOOD)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
})

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  delete process.env.CURRENCY_STATUS
  delete process.env.CURRENCY_IS_ASSET_ANCHORED
  delete process.env.CURRENCY_DESC
})

describe('the anchor page promises a wallet developer nothing that can go stale', () => {
  it('carries no dating or promise word in the source of the page and the two chrome components, read by explicit path — blind spot named: a file read cannot see a word split across a JSX expression, and it does see words inside export const metadata', () => {
    const read = SOURCES.map((path) => ({
      path,
      text: readFileSync(resolve(process.cwd(), path), 'utf8'),
    }))

    expect(read).toHaveLength(SOURCES.length)
    expect(read.map((file) => file.path)).toContain('app/anchor/page.tsx')
    for (const file of read) {
      expect(file.text.length, `${file.path} was read as empty`).toBeGreaterThan(0)
    }

    for (const file of read) {
      expect(file.path + ': ' + (file.text.match(DATING_WORD)?.[0] ?? '')).toBe(file.path + ': ')
    }
  })

  it('nowhere carries the sentence "Nothing further happens on this transaction", because expired is not terminal on this anchor: EXPIRED and CANCELLED both report it, every on-chain target admits both as a from-status, and maintenance auto-refunds that pool', () => {
    const page = readFileSync(resolve(process.cwd(), 'app/anchor/page.tsx'), 'utf8')

    expect(page.length).toBeGreaterThan(0)
    expect(`x ${FINALITY_PROMISE}.`.split(FINALITY_PROMISE).length - 1).toBe(1)
    expect(page.split(FINALITY_PROMISE).length - 1).toBe(0)
  })

  it('fires on the words it bans and stays silent on the words that merely contain them', () => {
    for (const hit of ['Coming soon', 'currently unavailable', 'TODO: fix this', 'in beta', 'for now']) {
      expect(hit).toMatch(DATING_WORD)
    }
    for (const miss of ['sooner', 'concurrently', 'todos', 'betamax', 'swipe']) {
      expect(miss).not.toMatch(DATING_WORD)
    }
  })
})

describe('the anchor page a wallet developer lands on', () => {
  it('carries the six sections, and points at the one document that is the authority', async () => {
    render(await AnchorPage())

    for (const name of SECTIONS) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: TOML_URL })).toHaveAttribute('href', TOML_URL)
  })

  it('reads the values it states out of the toml this anchor actually serves, rather than transcribing them', async () => {
    process.env.STELLAR_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015'
    process.env.CURRENCY_STATUS = 'live'
    process.env.CURRENCY_IS_ASSET_ANCHORED = 'true'
    process.env.CURRENCY_DESC = 'USDC settled through lolipay peer-to-peer escrow.'
    process.env.CURRENCY_ANCHOR_ASSET_TYPE = 'fiat'
    process.env.CURRENCY_ANCHOR_ASSET = 'USD'

    try {
      render(await AnchorPage())

      expect(screen.getByText('Public Global Stellar Network ; September 2015')).toBeInTheDocument()
      expect(screen.queryByText('Test SDF Network ; September 2015')).toBeNull()
      expect(screen.getByText('live')).toBeInTheDocument()
      expect(screen.queryByText('test')).toBeNull()
      expect(screen.getByText('true')).toBeInTheDocument()
      expect(screen.queryByText('false')).toBeNull()

      expect(screen.queryAllByText(/is not backed by anything/)).toHaveLength(0)
      expect(screen.queryAllByText(/test network passphrase/)).toHaveLength(0)
    } finally {
      delete process.env.CURRENCY_ANCHOR_ASSET_TYPE
      delete process.env.CURRENCY_ANCHOR_ASSET
    }
  })

  it('names no version number, because a SEP-1 version is not a fact a wallet branches on and a transcribed one goes stale', async () => {
    render(await AnchorPage())

    expect(screen.queryByText('2.7.0')).toBeNull()
    expect(screen.queryByText('VERSION')).toBeNull()
  })

  it('shows a dash where the toml declines to publish a value, rather than throwing or printing undefined', async () => {
    delete process.env.USDC_ASSET_ISSUER

    render(await AnchorPage())

    expect(screen.getAllByText('—')).toHaveLength(2)
    expect(screen.getByText('Test SDF Network ; September 2015')).toBeInTheDocument()

    expect(screen.queryAllByText(/desc says the same in words/)).toHaveLength(0)
  })

  it('warns on both expired rows that the status is not terminal, because a wallet that stops polling there can leave its user with USDC still locked', async () => {
    render(await AnchorPage())

    const terms = screen.getAllByText('expired')
    expect(terms).toHaveLength(2)

    for (const term of terms) {
      const meaning = term.nextElementSibling?.textContent ?? ''
      expect(meaning).toMatch(/is not terminal/)
      expect(meaning).toMatch(/do not stop polling/i)
    }
  })
})

describe('the chrome that carries a reader between the two pages', () => {
  it('sends every named nav and footer jump to the home page rather than to a fragment that resolves nowhere off it, and offers the anchor page once — the bare hash on the unwritten legal pages is out of scope and left alone', () => {
    render(
      <>
        <Nav />
        <Footer />
      </>,
    )

    const links = screen.getAllByRole('link')
    expect(links.length).toBeGreaterThan(8)

    const hrefs = links.map((link) => link.getAttribute('href') ?? '')
    expect(hrefs.filter((href) => /^#./.test(href))).toEqual([])
    expect(hrefs.filter((href) => href === '/anchor')).toHaveLength(1)
    expect(hrefs.filter((href) => href.startsWith('/#'))).toHaveLength(7)
  })
})
