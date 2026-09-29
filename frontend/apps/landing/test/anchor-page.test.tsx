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

const WITHDRAWN = [
  'was never available either',
  'loses the routes that would complete it',
  'keeps the one that returns the USDC',
  'when the person cannot sign it themselves',
  'A deposit is unaffected',
  'can complete its own side of a withdrawal',
  'So a pause does not stop a funded deposit completing',
  'has no on-chain move of their own',
  "ends that deposit's chance of completing",
  'Those four are the only calls that read it',
  'checks only the clock',
  'every call that could still complete the deposit is one a pause stops',
  'the deposit cannot complete while it is in force',
  'The refund opens on its own clock',
  'every paragraph after this one',
  'that is where a single privileged lolipay key',
  'the only route on which a single privileged lolipay key',
  'records who was liable',
  'nothing moves and the verdict records liability',
  "Which of the trade's two accounts receives the USDC follows the outcome",
  'chooses between the two destinations the trade already holds',
  'the outcome still names one of the two accounts the trade already holds',
  'and the paragraphs below call it the provider',
  'each status after this one behaves the same',
  'The refund returns the USDC to the provider',
  'A cancel returns the USDC to the provider',
  "the provider's release",
  "on the provider's signature",
  'A trade whose provider never releases',
  'The person and the provider may each raise one',
  'those two outcomes move the USDC the same way',
  'back with the provider through the refund',
  'the only place a lolipay key moves an escrow alone',
  'neither party holds the key that ends it',
  'nothing for your wallet to read on the SEP-24 record',
  'can and cannot reach is below',
  'change where the money goes.',
  'Render message, which tells the person to keep',
  'keep their transfer receipt.',
  'Tell your user to keep their transfer receipt',
  'accepts a file they attach',
]

const TRADE_STATE_HEADINGS = [
  'Funded: what moves a trade, and what a pause refuses',
  'FiatPaid: one signature, or a dispute, and no clock on either',
  'Released or Refunded: only a dispute still reaches a settled trade',
  'Disputed: who resolves it, and how many signatures that takes',
]

const SECTIONS = [
  'The anchor, and the one document that describes it',
  "What lolipay holds a key for in a trade's escrow, and what no key can reach there",
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

    expect(SOURCES).toHaveLength(3)
    expect(read.map((file) => file.path)).toContain('app/anchor/page.tsx')
    for (const file of read) {
      expect(file.text.length, `${file.path} was read as empty`).toBeGreaterThan(0)
    }

    for (const file of read) {
      expect.soft(file.path + ': ' + (file.text.match(DATING_WORD)?.[0] ?? '')).toBe(file.path + ': ')
    }
  })

  it('nowhere carries the sentence "Nothing further happens on this transaction", because expired is not terminal on this anchor: EXPIRED and CANCELLED both report it, every on-chain target admits both as a from-status, and maintenance auto-refunds that pool', () => {
    const page = readFileSync(resolve(process.cwd(), 'app/anchor/page.tsx'), 'utf8')

    expect(page.length).toBeGreaterThan(0)
    expect(`x ${FINALITY_PROMISE}.`.split(FINALITY_PROMISE).length - 1).toBe(1)
    expect(page.split(FINALITY_PROMISE).length - 1).toBe(0)
  })

  it('fires on the words it bans and stays silent on the words that merely contain them, and keeps all eighteen banned words in this exact set and order', () => {
    expect(BANNED.join('|')).toBe(
      'soon|beta|currently|for now|at the moment|shortly|eventually|upcoming|roadmap|stay tuned|under construction|in progress|todo|tbd|wip|fixme|placeholder|lorem',
    )
    for (const hit of ['Coming soon', 'currently unavailable', 'TODO: fix this', 'in beta', 'for now']) {
      expect(hit).toMatch(DATING_WORD)
    }
    for (const miss of ['sooner', 'concurrently', 'todos', 'betamax', 'swipe']) {
      expect(miss).not.toMatch(DATING_WORD)
    }
  })
})

describe('the custody and withdrawal prose carries only the clauses the ruling left standing', () => {
  it('carries none of the forty-one withdrawn clauses, and none of them is degenerate, and does carry the two narrowed replacements and a86e926\'s two corrected sentences', () => {
    const page = readFileSync(resolve(process.cwd(), 'app/anchor/page.tsx'), 'utf8')

    expect(page.length).toBeGreaterThan(0)
    expect(WITHDRAWN).toHaveLength(41)
    expect(WITHDRAWN.every((clause) => clause.length > 0)).toBe(true)
    for (const clause of WITHDRAWN) {
      expect.soft(`${clause}: ${page.split(clause).length - 1}`).toBe(`${clause}: 0`)
    }
    expect.soft(page).toContain('can and cannot reach in that escrow is below')
    expect.soft(page).toContain('change where the money goes in it.')
    expect.soft(page).toContain('Do not compose your own copy for this status: render message, in full.')
    expect.soft(page).toContain('A wallet that shows only the receipt clause drops that.')
  })
})

describe('the anchor page a wallet developer lands on', () => {
  it('carries the six sections, and points at the one document that is the authority', async () => {
    render(await AnchorPage())

    expect(SECTIONS).toHaveLength(6)
    for (const name of SECTIONS) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('link', { name: TOML_URL })).toHaveAttribute('href', TOML_URL)
  })

  it("names each of the four trade states as its own heading, and pins that heading's own accessible name to exactly this string, case included", async () => {
    render(await AnchorPage())

    expect(TRADE_STATE_HEADINGS).toHaveLength(4)
    for (const name of TRADE_STATE_HEADINGS) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument()
      expect(screen.queryByRole('heading', { name: name.toLowerCase() })).toBeNull()
    }
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
  it('sends every named nav and footer jump to the home page rather than to a fragment that resolves nowhere off it, and each chrome surface offers the anchor page exactly once — the unwritten legal items are plain text now, not dead links, so there is no bare hash left to exempt', () => {
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
    for (const surface of [screen.getByRole('navigation'), screen.getByRole('contentinfo')]) {
      expect(surface.querySelectorAll('a[href="/anchor"]'), surface.tagName).toHaveLength(1)
    }
    expect(hrefs.filter((href) => href.startsWith('/#'))).toHaveLength(7)
  })
})
