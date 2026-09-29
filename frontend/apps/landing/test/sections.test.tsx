import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Nav } from '../components/Nav'
import { HeroCopy } from '../components/HeroCopy'
import { HowItWorks } from '../components/HowItWorks'
import { Features } from '../components/Features'
import { TrustStrip } from '../components/TrustStrip'
import { ProvidersCta } from '../components/ProvidersCta'
import { Footer } from '../components/Footer'

describe('landing sections', () => {
  it('nav has a single "Connect wallet" link to the app and no Log in / Launch app', () => {
    render(<Nav />)
    expect(screen.getByRole('link', { name: /connect wallet/i })).toHaveAttribute('href', 'https://app.lolipay.app')
    expect(screen.queryByText(/log in/i)).toBeNull()
    expect(screen.queryByText(/launch app/i)).toBeNull()
  })
  it('nav links to the anchor page', () => {
    render(<Nav />)
    const hrefs = screen.getAllByRole('link').map((link) => link.getAttribute('href'))
    expect(hrefs).toContain('/anchor')
  })
  it('hero shows the headline and only the honest stats (no fake volume/corridor numbers, and no settlement-speed figure that would drift from the one on TrustStrip)', () => {
    render(<HeroCopy />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/spend crypto/i)
    expect(screen.queryByText(/\$1\.4M/)).toBeNull()
    expect(screen.queryByText(/40\+/)).toBeNull()
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText('non-custodial')).toBeInTheDocument()
    expect(screen.queryByText('~5s')).toBeNull()
    expect(screen.queryByText('on-chain settlement')).toBeNull()
    expect(screen.getByText('0')).toBeInTheDocument()
    expect(screen.getByText('funds we custody')).toBeInTheDocument()
  })
  it('how-it-works has the 3 steps under the anchor', () => {
    render(<HowItWorks />)
    expect(screen.getByText('Enter an amount')).toBeInTheDocument()
    expect(screen.getByText('A provider takes it')).toBeInTheDocument()
    expect(screen.getByText('Settled on-chain')).toBeInTheDocument()
  })
  it('features lists all 6 cards', () => {
    render(<Features />)
    for (const t of ['Cash out to your bank', 'Buy & sell USDC', 'Rated providers', 'Escrow security', 'Live rates', 'You hold the keys']) {
      expect(screen.getByText(t)).toBeInTheDocument()
    }
  })
  it('providers CTA points to lp.lolipay.app', () => {
    render(<ProvidersCta />)
    expect(screen.getByRole('link', { name: /become a provider/i })).toHaveAttribute('href', 'https://lp.lolipay.app')
  })
  it('footer names the public product surfaces and omits the internal admin link', () => {
    render(<Footer />)
    for (const t of ['app.lolipay.app', 'lp.lolipay.app']) {
      expect(screen.getByText(t)).toBeInTheDocument()
    }
    expect(screen.queryByText('admin.lolipay.app')).toBeNull()
  })
  it('names Terms, Privacy and Risk notice as plain text, never as a link that goes nowhere', () => {
    render(<Footer />)
    for (const t of ['Terms', 'Privacy', 'Risk notice']) {
      expect(screen.getByText(t)).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: t })).toBeNull()
    }
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toBe('#')
    }
  })
})

describe('the seven copy fixes leave no withdrawn phrase standing, elsewhere on the page they cannot be seen from (a rewording of the same claim would still pass this)', () => {
  it('renders none of the withdrawn phrases across HowItWorks, Features, TrustStrip and ProvidersCta', () => {
    render(
      <>
        <HowItWorks />
        <Features />
        <TrustStrip />
        <ProvidersCta />
      </>,
    )

    const WITHDRAWN_PATTERNS = [
      /Fully pseudonymous/i,
      /no bank details/i,
      /mid-market/i,
      /before you trade/i,
      /Connect a wallet and go/i,
      /every few seconds/i,
      /\bUPI\b/i,
      /\bPIX\b/i,
      /and more/i,
      /& more/i,
    ]
    for (const pattern of WITHDRAWN_PATTERNS) {
      expect(screen.queryByText(pattern)).toBeNull()
    }

    expect(screen.getByText('No KYC to browse, and no custody of your coins — ever.')).toBeInTheDocument()
    expect(screen.getByText(/Top up from local currency or cash out to your bank at a rate you see before you commit\./)).toBeInTheDocument()
    expect(screen.getByText(/Every counterparty is staked and rated\. See their track record on every order\./)).toBeInTheDocument()
    expect(screen.getByText(/Rates refresh every twelve seconds and lock for five minutes at checkout/)).toBeInTheDocument()
    expect(screen.getByText('QRIS · bank · e-wallet')).toBeInTheDocument()
    expect(screen.getByText(/You choose the\s*rails — bank, QRIS and e-wallet\./)).toBeInTheDocument()
  })
})
