import type { Page } from '@playwright/test'

export const MOCK_RATE = {
  asset: 'USDC',
  fiat: 'IDR',
  rate: '16000',
  ts: new Date().toISOString(),
}

export const MOCK_QUOTE = {
  quote_id: 'q1',
  fiat_amount: '1600000',
  rate: '16000',
  platform_fee_bps: 30,
  lp_fee_bps: 120,
  expires_at: new Date(Date.now() + 120_000).toISOString(),
}

const BASE_ORDER = {
  id: 'o1',
  trade_id: 'trade1',
  user_address: 'GDTEST000000000000000000000000000000000000000000000000000',
  lp_wallet: 'GDLP0000000000000000000000000000000000000000000000000000000',
  flow: 'TOP_UP' as const,
  rail: 'BANK' as const,
  usdc_amount: '1000000000',
  fiat_amount: '1600000',
  fiat_currency: 'IDR',
  rate_snapshot: '16000',
  platform_fee_bps: 30,
  lp_fee_bps: 120,
  pay_deadline: Math.floor(Date.now() / 1000) + 3600,
  confirm_deadline: Math.floor(Date.now() / 1000) + 7200,
  dispute_deadline: Math.floor(Date.now() / 1000) + 86400,
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  created_at: new Date().toISOString(),
}

export const MOCK_ORDER_MATCHED = {
  ...BASE_ORDER,
  status: 'MATCHED' as const,
}

export const MOCK_ORDER_FUNDED = {
  ...BASE_ORDER,
  status: 'FUNDED' as const,
  payment_instructions: 'BCA 1234567890 a/n TEST MERCHANT',
}

export async function setupApiMocks(
  page: Page,
  order: typeof MOCK_ORDER_MATCHED | typeof MOCK_ORDER_FUNDED = MOCK_ORDER_MATCHED,
): Promise<void> {
  await page.addInitScript(() => {
    window.sessionStorage.setItem('lp_jwt', 'e2e-test-jwt')
    window.sessionStorage.setItem(
      'lp_addr',
      'GDTEST000000000000000000000000000000000000000000000000000',
    )
  })

  await page.route('https://api.lolipay.app/**', (route) => {
    const url = new URL(route.request().url())
    const method = route.request().method()
    const pathname = url.pathname

    if (method === 'GET' && pathname === '/rate') {
      return route.fulfill({ json: MOCK_RATE })
    }

    if (method === 'POST' && pathname === '/quotes') {
      return route.fulfill({ json: MOCK_QUOTE })
    }

    if (method === 'POST' && pathname === '/auth/challenge') {
      return route.fulfill({ json: { nonce: 'test-nonce-abc123' } })
    }

    if (method === 'POST' && pathname === '/auth/verify') {
      return route.fulfill({ json: { jwt: 'test-jwt-token' } })
    }

    if (method === 'POST' && pathname === '/orders') {
      return route.fulfill({ json: { order: MOCK_ORDER_MATCHED } })
    }

    if (method === 'GET' && pathname === '/orders/o1') {
      return route.fulfill({ json: order })
    }

    if (method === 'GET' && pathname === '/orders/o1/tx/mark-paid') {
      return route.fulfill({
        json: {
          xdr: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          networkPassphrase: 'Test SDF Network ; September 2015',
        },
      })
    }

    if (method === 'GET' && pathname === '/orders') {
      return route.fulfill({ json: [] })
    }
    if (method === 'GET' && pathname === '/notifications') {
      return route.fulfill({ json: { items: [], unread: 0 } })
    }

    return route.abort()
  })
}
