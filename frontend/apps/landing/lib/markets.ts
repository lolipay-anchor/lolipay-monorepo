export interface Market {
  country: string
  code: string
  symbol: string
  rail: string

  base: number
  locale: string
  enabled: boolean
}

export const MARKETS: Market[] = [
  { country: 'Indonesia', code: 'IDR', symbol: 'Rp', rail: 'QRIS', base: 16732, locale: 'id-ID', enabled: true },
  { country: 'Philippines', code: 'PHP', symbol: '₱', rail: 'InstaPay', base: 58.5, locale: 'en-PH', enabled: false },
  { country: 'Vietnam', code: 'VND', symbol: '₫', rail: 'VietQR', base: 25400, locale: 'vi-VN', enabled: false },
  { country: 'India', code: 'INR', symbol: '₹', rail: 'UPI', base: 83.4, locale: 'en-IN', enabled: false },
  { country: 'Thailand', code: 'THB', symbol: '฿', rail: 'PromptPay', base: 36.2, locale: 'th-TH', enabled: false },
  { country: 'Brazil', code: 'BRL', symbol: 'R$', rail: 'PIX', base: 5.42, locale: 'pt-BR', enabled: false },
]

export function formatLocal(n: number, m: Market): string {
  const dp = m.base < 100 ? 2 : 0
  return `${m.symbol} ${Number(n).toLocaleString(m.locale, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`
}
