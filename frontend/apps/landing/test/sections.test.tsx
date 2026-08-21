import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Nav } from '../components/Nav'
import { HeroCopy } from '../components/HeroCopy'
import { HowItWorks } from '../components/HowItWorks'
import { Features } from '../components/Features'
import { ProvidersCta } from '../components/ProvidersCta'
import { Footer } from '../components/Footer'

describe('landing sections', () => {
  it('nav has a single "Connect wallet" link to the app and no Log in / Launch app', () => {
    render(<Nav />)
    expect(screen.getByRole('link', { name: /connect wallet/i })).toHaveAttribute('href', 'https://app.lolipay.app')
    expect(screen.queryByText(/log in/i)).toBeNull()
    expect(screen.queryByText(/launch app/i)).toBeNull()
  })
  it('hero shows the headline and only the honest stats (no fake volume/corridor numbers)', () => {
    render(<HeroCopy />)
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/spend crypto/i)
    expect(screen.queryByText(/\$1\.4M/)).toBeNull()
    expect(screen.queryByText(/40\+/)).toBeNull()
    expect(screen.getByText('100%')).toBeInTheDocument()
    expect(screen.getByText('non-custodial')).toBeInTheDocument()
    expect(screen.getByText('~5s')).toBeInTheDocument()
    expect(screen.getByText('on-chain settlement')).toBeInTheDocument()
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
})
