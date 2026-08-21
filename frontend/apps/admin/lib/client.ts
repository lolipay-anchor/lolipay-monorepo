import { ApiClient } from '@lolipay/api-client'

export const client = new ApiClient({
  baseUrl: process.env.NEXT_PUBLIC_API_BASE ?? 'https://api.lolipay.app',
  getToken: () =>
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('lp_jwt') : null,
  setToken: (t) => {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem('lp_jwt', t)
  },
})
