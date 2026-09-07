import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiClient, ApiError, SESSION_EXPIRED, SESSION_EXPIRED_EVENT } from '@lolipay/api-client'

function clientWith(token: string | null) {
  const setToken = vi.fn()
  return { client: new ApiClient({ baseUrl: 'https://api.x', getToken: () => token, setToken }), setToken }
}

describe('a dead session is named once, and the app is told', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names the event the providers listen for', () => {
    expect(SESSION_EXPIRED_EVENT).toBe('lolipay:session-expired')
  })

  it('a request that carried a token and was refused with 401 forgets the token, tells the window, and says so', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) }))
    const heard = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, heard)
    const { client, setToken } = clientWith('jwt')
    const err = await client.request('GET', '/orders').catch((e) => e)
    window.removeEventListener(SESSION_EXPIRED_EVENT, heard)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
    expect(err.message).toBe(SESSION_EXPIRED)
    expect(setToken).toHaveBeenCalledWith('')
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('a download that carried a token and was refused with 401 behaves the same', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }))
    const heard = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, heard)
    const { client, setToken } = clientWith('jwt')
    const err = await client.requestBlob('GET', '/orders/o1/proof').catch((e) => e)
    window.removeEventListener(SESSION_EXPIRED_EVENT, heard)
    expect(err.message).toBe(SESSION_EXPIRED)
    expect(setToken).toHaveBeenCalledWith('')
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('a 401 with no token, which is a failed login, keeps the anchor sentence and touches nothing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'address is not a proven wallet' }) }))
    const heard = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, heard)
    const { client, setToken } = clientWith(null)
    const err = await client.request('POST', '/auth/verify', {}).catch((e) => e)
    window.removeEventListener(SESSION_EXPIRED_EVENT, heard)
    expect(err.message).toBe('address is not a proven wallet')
    expect(setToken).not.toHaveBeenCalled()
    expect(heard).not.toHaveBeenCalled()
  })

  it('a 403 with a token is a refusal, not an expiry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, json: async () => ({ message: 'Forbidden' }) }))
    const heard = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, heard)
    const { client, setToken } = clientWith('jwt')
    const err = await client.request('GET', '/admin/orders').catch((e) => e)
    window.removeEventListener(SESSION_EXPIRED_EVENT, heard)
    expect(err.status).toBe(403)
    expect(err.message).toBe('Forbidden')
    expect(setToken).not.toHaveBeenCalled()
    expect(heard).not.toHaveBeenCalled()
  })

  it('a late 401 for a token that has since been replaced leaves the new session alone', async () => {
    let current: string | null = 'dead'
    const setToken = vi.fn((t: string) => {
      current = t
    })
    const client = new ApiClient({ baseUrl: 'https://api.x', getToken: () => current, setToken })
    let answer!: (r: unknown) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise((r) => { answer = r })))
    const heard = vi.fn()
    window.addEventListener(SESSION_EXPIRED_EVENT, heard)
    const pending = client.request('GET', '/orders').catch((e) => e)
    current = 'fresh'
    answer({ ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) })
    const err = await pending
    window.removeEventListener(SESSION_EXPIRED_EVENT, heard)
    expect(err.message).toBe(SESSION_EXPIRED)
    expect(setToken).not.toHaveBeenCalled()
    expect(heard).not.toHaveBeenCalled()
    expect(current).toBe('fresh')
  })

  it('an empty-bodied failure still names the request, which the order screens rely on', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('no body') } }))
    const { client } = clientWith('jwt')
    const err = await client.request('POST', '/orders', {}).catch((e) => e)
    expect(err.message).toBe('POST /orders → 502')
  })
})
