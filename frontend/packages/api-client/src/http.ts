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
    if (!res.ok) {
      let detail = ''
      try {
        const b = (await res.json()) as { message?: string | string[] }
        detail = Array.isArray(b?.message) ? b.message.join(', ') : b?.message ?? ''
      } catch {
      }
      if (res.status === 429) detail = detail || 'Too many attempts — please wait a moment and try again'
      throw new ApiError(res.status, detail || `${method} ${path} → ${res.status}`)
    }

    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  async requestBlob(method: string, path: string): Promise<Blob> {
    const token = this.o.getToken()
    const headers: Record<string, string> = {}
    if (token) headers.Authorization = `Bearer ${token}`
    const res = await fetch(this.o.baseUrl + path, { method, headers })
    if (!res.ok) {
      let detail = ''
      try {
        const b = (await res.json()) as { message?: string | string[] }
        detail = Array.isArray(b?.message) ? b.message.join(', ') : b?.message ?? ''
      } catch {
      }
      throw new ApiError(res.status, detail || `${method} ${path} → ${res.status}`)
    }
    return res.blob()
  }
}
