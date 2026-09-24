import { readFileSync } from 'fs'
import path from 'path'
import { describe, it, expect } from 'vitest'

describe('the web card rail nouns agree with the SEP-24 popup', () => {
  it('BANK, EWALLET and QRIS read identically on both surfaces', () => {
    const popupSource = readFileSync(
      path.resolve(__dirname, '../../../../services/coordinator/src/sep24/sep24.service.ts'),
      'utf8',
    )
    const match = popupSource.match(/const RAIL_WORDS: Record<Rail, string> = \{([^}]+)\}/)
    expect(match).toBeTruthy()

    const popupWords: Record<string, string> = {}
    for (const line of match![1].split('\n')) {
      const kv = line.match(/(\w+):\s*'([^']*)'/)
      if (kv) popupWords[kv[1]] = kv[2]
    }
    expect(popupWords).toEqual({
      BANK: 'bank account',
      EWALLET: 'e-wallet',
      QRIS: 'QRIS code',
    })

    const cardSource = readFileSync(
      path.resolve(__dirname, '../components/OrderStatus.tsx'),
      'utf8',
    )
    const cardMatch = cardSource.match(/const RAIL_WORDS: Record<Rail, string> = \{([^}]+)\}/)
    expect(cardMatch).toBeTruthy()

    const cardWords: Record<string, string> = {}
    for (const line of cardMatch![1].split('\n')) {
      const kv = line.match(/(\w+):\s*'([^']*)'/)
      if (kv) cardWords[kv[1]] = kv[2]
    }

    expect(cardWords).toEqual(popupWords)
  })
})
