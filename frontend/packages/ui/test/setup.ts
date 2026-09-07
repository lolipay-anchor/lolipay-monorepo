import { afterEach } from 'vitest'
import { cleanup } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'

afterEach(() => {
  cleanup()
})

globalThis.fetch = (() => Promise.reject(new Error('unmocked fetch in a test — mock the endpoint'))) as unknown as typeof fetch
