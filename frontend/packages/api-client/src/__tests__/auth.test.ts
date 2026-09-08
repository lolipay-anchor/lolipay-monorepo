import { describe, it, expect, vi, afterEach } from 'vitest'
import { ApiClient, ApiError, SESSION_EXPIRED, authenticate } from '../index'

describe('auth', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('runs challenge → sign → verify and stores the jwt', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ nonce: 'NONCE' }) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ jwt: 'JWT' }) })
    vi.stubGlobal('fetch', fetchMock)
    let stored: string | null = null
    const client = new ApiClient({ baseUrl: 'https://api.x', getToken: () => stored, setToken: t => (stored = t) })
    const signMessage = vi.fn(async (m: string) => 'SIG:' + m)
    await authenticate(client, 'GADDR', signMessage)

    expect(signMessage).toHaveBeenCalledWith('NONCE', 'GADDR')
    expect(stored).toBe('JWT')

    const verifyBody = JSON.parse(fetchMock.mock.calls[1][1].body)
    expect(verifyBody.nonce).toBe('NONCE')
    expect(verifyBody.address).toBe('GADDR')
    expect(verifyBody.signature).toBe('SIG:NONCE')

    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ([]) })
    await client.request('GET', '/orders')
    const headers = fetchMock.mock.calls[2][1].headers
    expect(headers.Authorization).toBe('Bearer JWT')
  })

  it('rejects with ApiError whose .status matches on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }))
    const client = new ApiClient({ baseUrl: 'https://api.x', getToken: () => null, setToken: () => {} })
    const err = await client.request('GET', '/orders').catch(e => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
  })

  it('omits Authorization header when getToken returns null', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ([]) })
    vi.stubGlobal('fetch', fetchMock)
    const client = new ApiClient({ baseUrl: 'https://api.x', getToken: () => null, setToken: () => {} })
    await client.request('GET', '/orders')
    const headers = fetchMock.mock.calls[0][1].headers
    expect(headers.Authorization).toBeUndefined()
  })

  it('names a session that has expired when a request that carried a token is refused with 401, and forgets the token', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ message: 'Unauthorized' }) }))
    const setToken = vi.fn()
    const client = new ApiClient({ baseUrl: 'https://api.x', getToken: () => 'jwt', setToken })
    const err = await client.request('GET', '/orders').catch(e => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
    expect(err.message).toBe(SESSION_EXPIRED)
    expect(setToken).toHaveBeenCalledWith('')
  })
  it('names the request when a 2xx body cannot be read, so a parser message never reaches a user', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token \'<\', "<html>" is not valid JSON')
        },
      }),
    )
    const client = new ApiClient({ baseUrl: 'https://api.x', getToken: () => null, setToken: () => {} })
    const err = await client.request('GET', '/quotes').then(
      () => {
        throw new Error('expected a refusal')
      },
      (e) => e as ApiError,
    )
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(200)
    expect(err.message).toBe('GET /quotes → 200')
  })
})
