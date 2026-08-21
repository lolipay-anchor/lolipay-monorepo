import { describe, it, expect } from 'vitest'
import preset, { lpTokens, tokens } from '@lolipay/config/tailwind-preset'

describe('redesign tokens', () => {
  it('exposes the handoff palette under the lp- prefix', () => {
    expect(lpTokens['lp-accent']).toBe('#E6396B')
    expect(lpTokens['lp-accent-ink']).toBe('#B4234F')
    expect(lpTokens['lp-ink']).toBe('#18181B')
    expect(lpTokens['lp-raise']).toBe('#F7F7F6')
    expect(lpTokens['lp-green-soft']).toBe('#E1F2E8')
    expect(lpTokens['lp-usdc']).toBe('#2775CA')
  })
  it('keeps the legacy palette untouched (no visual change this phase)', () => {
    expect(tokens.primary).toBe('#2563EB')
    expect(tokens.bg).toBe('#F8FAFC')
  })
  it('registers the handoff animations and radii', () => {
    const ext = (preset as any).theme.extend
    expect(Object.keys(ext.keyframes)).toEqual(
      expect.arrayContaining(['lp-rise', 'lp-pulse', 'lp-scan']),
    )
    expect(ext.animation['lp-pulse']).toContain('1.6s')
    expect(ext.borderRadius['lp-card']).toBe('20px')
    expect(ext.borderRadius['lp-pill']).toBe('9px')
    expect(ext.boxShadow['lp-cta']).toBe('0 8px 20px -8px #E6396B')
  })
})
