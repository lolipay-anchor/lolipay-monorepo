import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@lolipay/api-client', async (importOriginal) => {
  const mod = await importOriginal<any>()
  return { ...mod, getRate: vi.fn().mockResolvedValue({ asset: 'USDC', fiat: 'IDR', rate: '16000', ts: '2026-07-07T00:00:00Z' }) }
})
import { getRate } from '@lolipay/api-client'
import { Nav } from '../components/Nav'
import { HeroCopy } from '../components/HeroCopy'
import { BuySellWidget } from '../components/BuySellWidget'

const APP_URL = 'https://app.lolipay.app'

beforeEach(() => {
  vi.mocked(getRate).mockClear()
})

describe('Connect wallet routes to the app', () => {
  it('nav Connect wallet is a link to app.lolipay.app', () => {
    render(<Nav />)
    expect(screen.getByRole('link', { name: /connect wallet/i })).toHaveAttribute('href', APP_URL)
  })

  it('hero has Buy USDC and Connect wallet, both linking to the app', () => {
    render(<HeroCopy />)
    expect(screen.getByRole('link', { name: /buy usdc/i })).toHaveAttribute('href', APP_URL)
    expect(screen.getByRole('link', { name: /connect wallet/i })).toHaveAttribute('href', APP_URL)
  })

  it('widget CTA links to the app', async () => {
    render(<BuySellWidget />)
    expect(screen.getByRole('link', { name: /connect wallet to continue/i })).toHaveAttribute(
      'href',
      APP_URL,
    )
  })
})

