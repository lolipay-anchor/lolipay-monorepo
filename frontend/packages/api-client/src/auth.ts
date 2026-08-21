import { ApiClient } from './http'
export async function authenticate(
  client: ApiClient,
  address: string,

  signMessage: (m: string, address?: string) => Promise<string>,
) {
  const { nonce } = await client.request<{ nonce: string }>('POST', '/auth/challenge', { address })
  const signature = await signMessage(nonce, address)
  const { jwt } = await client.request<{ jwt: string }>('POST', '/auth/verify', { address, nonce, signature })
  client.setToken(jwt)
}
