import { tokens } from '@lolipay/config/tailwind-preset'
import { describe, it, expect } from 'vitest'
describe('tokens', () => {
  it('exposes the Airy-Indigo primary', () => {
    expect(tokens.primary).toBe('#2563EB')
    expect(tokens.bg).toBe('#F8FAFC')
  })
})
