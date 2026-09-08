export const SESSION_EXPIRED_EVENT = 'lolipay:session-expired'
export const SESSION_EXPIRED = 'Your session expired. Reconnect your wallet to continue.'

export class ApiError extends Error { constructor(public status: number, msg: string){ super(msg) } }
export class ApiClient {
  constructor(private o: { baseUrl: string; getToken: () => string | null; setToken: (t: string) => void }) {}
  get setToken() { return this.o.setToken }

  get baseUrl() { return this.o.baseUrl }
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.o.getToken()

    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData
    const headers: Record<string,string> = isFormData ? {} : { 'Content-Type': 'application/json' }
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(this.o.baseUrl + path, {
      method,
      headers,
      body: isFormData ? (body as FormData) : body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) await this.refuse(res, token, method, path)

    if (res.status === 204) return undefined as T
    try {
      return (await res.json()) as T
    } catch {
      throw new ApiError(res.status, `${method} ${path} → ${res.status}`)
    }
  }

  async requestBlob(method: string, path: string): Promise<Blob> {
    const token = this.o.getToken()
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(this.o.baseUrl + path, { method, headers })
    if (!res.ok) await this.refuse(res, token, method, path)
    return res.blob()
  }

  private async refuse(res: Response, token: string | null, method: string, path: string): Promise<never> {
    let detail = ''
    try {
      const b = (await res.json()) as { message?: string | string[] }
      detail = Array.isArray(b?.message) ? b.message.join(', ') : b?.message ?? ''
    } catch {
    }
    if (res.status === 401 && token) {
      if (this.o.getToken() === token) {
        this.o.setToken('')
        if (typeof window !== 'undefined') window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT))
      }
      throw new ApiError(401, SESSION_EXPIRED)
    }
    if (res.status === 429) detail = detail || 'Too many attempts — please wait a moment and try again'
    throw new ApiError(res.status, detail || `${method} ${path} → ${res.status}`)
  }
}
