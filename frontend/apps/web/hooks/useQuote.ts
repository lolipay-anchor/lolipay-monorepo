import { useState, useEffect } from 'react'
import { usdcBaseUnitsFor } from '@/lib/money'
import { useQuery } from '@tanstack/react-query'
import { getRate, createQuote } from '@lolipay/api-client'
import { client } from '@/lib/client'
import type { Quote } from '@lolipay/api-client'
import { explainOrderRefusal, QUOTE_FALLBACK } from '@/lib/order-refusal'

export interface UseQuoteResult {
  quote: Quote | undefined
  refusal: string | undefined

  usdcAmount: string
  secondsLeft: number
  expired: boolean
  isLoading: boolean
}

export function useQuote(idrAmount: number): UseQuoteResult {
  const [debouncedIDR, setDebouncedIDR] = useState(idrAmount)
  useEffect(() => {
    const t = setTimeout(() => setDebouncedIDR(idrAmount), 400)
    return () => clearTimeout(t)
  }, [idrAmount])

  const { data: rateData } = useQuery({
    queryKey: ['rate'],
    queryFn: () => getRate(client, 'IDR'),
    staleTime: 30_000,
  })

  const usdcAmount = rateData ? usdcBaseUnitsFor(debouncedIDR, parseFloat(rateData.rate)) : '0'

  const enabled = rateData != null && BigInt(usdcAmount) >= 1n

  const { data: quote, isLoading: quoteLoading, error: quoteError } = useQuery({
    queryKey: ['quote', usdcAmount],
    queryFn: () =>
      createQuote(client, { flow: 'TOP_UP', rail: 'BANK', usdcAmount }),
    enabled,
    staleTime: 10_000,
  })

  const [secondsLeft, setSecondsLeft] = useState(0)
  useEffect(() => {
    if (!quote) {
      setSecondsLeft(0)
      return
    }
    const update = () =>
      setSecondsLeft(
        Math.max(
          0,
          Math.floor((Date.parse(quote.expires_at) - Date.now()) / 1000),
        ),
      )
    update()
    const interval = setInterval(update, 1000)
    return () => clearInterval(interval)
  }, [quote])

  const expired = !!quote && secondsLeft <= 0

  return {
    quote,
    refusal: quoteError ? explainOrderRefusal(quoteError.message, QUOTE_FALLBACK) : undefined,
    usdcAmount,
    secondsLeft,
    expired,
    isLoading: !rateData || (enabled && quoteLoading),
  }
}
